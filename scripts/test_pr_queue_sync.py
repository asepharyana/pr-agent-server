#!/usr/bin/env python3
"""
Unit tests for the pr-queue-worker upstream fork auto-sync section.

Run:  python3 scripts/test_pr_queue_sync.py

No network, no GitHub token, no real git: `gh_api`, `_sync_git`, the Claude
runner and the push helper are monkeypatched so the worker's *orchestration*
(merge path, conflict path, protected-branch path, CI verify/revert, gating and
state bookkeeping) is exercised deterministically. The git mechanics themselves
are covered by the live E2E (`--sync-only <repo> --dry`), not here.
"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent


def load_worker():
    spec = importlib.util.spec_from_file_location("pr_queue_worker", HERE / "pr-queue-worker.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


W = load_worker()
_real_sync_finish_merge = W._sync_finish_merge

PASSED = []
FAILED = []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"  ← {detail}"))


def cp(args, code=0, out="", err=""):
    return subprocess.CompletedProcess(args, code, out, err)


def make_state_file(tmpdir):
    """Point the worker's sync state at a temp file so tests never touch /tmp."""
    W.SYNC_STATE_FILE = pathlib.Path(tmpdir) / "sync-state.json"
    W.SYNC_TMP_BASE = pathlib.Path(tmpdir) / "sync-work"
    W.sync_config  # noqa: B018 — keep the reference obvious for readers


# ── 1. compare-API parsing ────────────────────────────────────────────────
def test_upstream_status_parsing():
    print("1. upstream_status parses ahead_by/behind_by/tip")
    calls = []

    def fake_gh(method, path, token=None, json_data=None, retries=3):
        calls.append(path)
        return 200, {
            "ahead_by": 4, "behind_by": 26,
            "commits": [{"sha": "aaa"}, {"sha": "bbb"}, {"sha": "ccc"}, {"sha": "4eafc064"}],
        }

    W.gh_api = fake_gh
    info = W.upstream_status("tok", "asepharyana/shiro-neko", "zakirkun/shiro-neko", "main", "main")
    check("merge_count is ahead_by", info == (4, 26, "4eafc064"), str(info))
    check("single compare call", len(calls) == 1, str(calls))
    check("compare path uses owner:branch head (not owner/repo:branch)",
          calls[0] == "/repos/asepharyana/shiro-neko/compare/main...zakirkun:main", str(calls))

    def failing_gh(method, path, token=None, json_data=None, retries=3):
        return 404, {"message": "Not Found"}

    W.gh_api = failing_gh
    check("unavailable compare → None", W.upstream_status("tok", "f", "p", "main", "main") is None)


# ── 2. gating: same upstream tip / interval not due ───────────────────────
def test_gating(tmpdir):
    print("2. run_upstream_sync gating (interval + same upstream tip)")
    make_state_file(tmpdir)
    attempts = []

    orig_list_forks = W.list_fork_repos
    W.list_fork_repos = lambda: [("tok", "asepharyana/shiro-neko", "zakirkun/shiro-neko", "main")]

    def fake_gh(method, path, token=None, json_data=None, retries=3):
        if "/compare/" in path:
            return 200, {"ahead_by": 4, "behind_by": 26, "commits": [{"sha": "up1"}]}
        if path.startswith("/repos/asepharyana/shiro-neko/pulls"):
            return 200, []
        if path.endswith("/repos/asepharyana/shiro-neko"):
            return 200, {"fork": True, "parent": {"full_name": "zakirkun/shiro-neko",
                                                  "default_branch": "main"},
                         "default_branch": "main"}
        return 200, {}

    W.gh_api = fake_gh
    W.post_sync_discord = lambda *a, **k: True
    orig_sync = W.sync_fork_repo

    def fake_sync(token, fork, parent, local_branch, upstream_branch, upstream_sha,
                  merge_count, divergence, state, cfg, dry=False):
        # mirror what the real function records so the gating is exercised
        attempts.append((upstream_sha, dry))
        entry = W._sync_entry(state, fork)
        entry["last_sync_ts"] = time.time()
        entry["last_attempt_sha"] = upstream_sha
        W.save_sync_state(state)
        return "synced", "fake"

    W.sync_fork_repo = fake_sync

    lines = W.run_upstream_sync()
    check("first tick attempts the sync", len(attempts) == 1, str(lines))

    lines = W.run_upstream_sync()
    check("second tick not attempted (same upstream tip)", len(attempts) == 1, str(lines))

    # upstream moves, but the interval has not elapsed → still no attempt
    def fake_gh2(method, path, token=None, json_data=None, retries=3):
        if "/compare/" in path:
            return 200, {"ahead_by": 5, "behind_by": 26, "commits": [{"sha": "up2"}]}
        if path == "/repos/asepharyana/shiro-neko":
            return 200, {"fork": True, "parent": {"full_name": "zakirkun/shiro-neko",
                                                  "default_branch": "main"},
                         "default_branch": "main"}
        return 200, []

    W.gh_api = fake_gh2
    lines = W.run_upstream_sync()
    check("interval gate blocks a fresh retry", len(attempts) == 1, str(lines) + str(attempts))

    # backdate the last attempt → the new upstream tip is picked up
    st = json.loads(W.SYNC_STATE_FILE.read_text())
    st["asepharyana/shiro-neko"]["last_sync_ts"] = time.time() - 2 * 3600
    W.SYNC_STATE_FILE.write_text(json.dumps(st))
    W.run_upstream_sync()
    check("new upstream tip attempts again once the interval elapsed",
          [a[0] for a in attempts] == ["up1", "up2"], str(attempts))
    W.sync_fork_repo = orig_sync  # later tests exercise the real implementation
    W.list_fork_repos = orig_list_forks


# ── 3. clean merge → push → pending_verify ────────────────────────────────
def _install_git_fake(merge_code=0, unmerged=None):
    """Fake `git` for sync_fork_repo: clone/config/rev-parse/fetch/merge."""
    state = {"head": "pre" + "0" * 37, "merges": [], "aborts": 0}

    def fake_git(args, cwd=None, timeout=180):
        a = [str(x) for x in args]
        if a[0] == "clone":
            return cp(a)
        if a[0] == "rev-parse":
            return cp(a, 0, state["head"] + "\n")
        if a[0] == "merge":
            if "--abort" in a:
                state["aborts"] += 1
                return cp(a)
            state["merges"].append(a)
            if merge_code == 0:
                state["head"] = "merge" + "1" * 36
            return cp(a, merge_code, "", "CONFLICT" if merge_code else "")
        if a[0] == "diff":
            # the merge diff (used for the quality pass) lists files; the
            # unmerged listing is served by the monkeypatched _sync_unmerged_files
            return cp(a, 0, "src/a.ts\nsrc/b.ts\n")
        if a[0] == "status":
            return cp(a, 0, "")
        return cp(a)

    W._sync_git = fake_git
    W._sync_unmerged_files = lambda workdir: list(unmerged or [])
    # Reset the marker guard too: tests that stub it out must not leak into the
    # next test (a leftover stub silently disabled the commit guard).
    W._sync_has_conflict_markers = lambda workdir: []
    # Reset _sync_finish_merge to the real implementation. Test 4 stubs it with
    # a fake that always succeeds — a leaked copy turns a FAILED resolution
    # (test 5, 15b) into a bogus salvage and hides the skip/abort behavior.
    W._sync_finish_merge = _real_sync_finish_merge
    return state


def test_clean_merge_synced(tmpdir):
    print("3. clean merge pushes and records pending_verify")
    make_state_file(tmpdir)
    state = {}
    gitstate = _install_git_fake(merge_code=0, unmerged=[])
    claude_calls = []
    W._run_claude_sync = lambda workdir, prompt, label, fork, dry=False: (claude_calls.append(label), (True, "ok"))[1]
    W._sync_commit_if_dirty = lambda workdir, msg: False
    pushes = []

    def fake_push(workdir, fork, source, dest, app_token, force=False):
        pushes.append((source, dest, force))
        return True, "pat push ok", False

    W._push_ref = fake_push
    res, detail = W.sync_fork_repo("tok", "asepharyana/shiro-neko", "zakirkun/shiro-neko",
                                  "main", "main", "up1", 4, 26, state, W.sync_config("x"))
    entry = state["asepharyana/shiro-neko"]
    check("status synced", res == "synced", f"{res} {detail}")
    check("pushed to the local branch", pushes and pushes[0][1] == "refs/heads/main", str(pushes))
    check("pending_verify records merge sha", entry["pending_verify"]["sha"] == gitstate["head"], str(entry))
    check("pending_verify records pre_merge sha", entry["pending_verify"]["pre_merge_sha"].startswith("pre"), str(entry))
    check("last_merged_upstream_sha recorded", entry["last_merged_upstream_sha"] == "up1", str(entry))
    check("clean merge gets a quality pass", claude_calls == ["hermes_sync_quality"], str(claude_calls))


def test_dry_run_is_pure(tmpdir):
    print("3b. --dry never writes state, never posts Discord, never pushes")
    # NOTE: the dry-path asserts `state == {}` — under the hood the worker builds
    # a NEW empty state dict for dry runs (run_upstream_sync sets state={});
    # sync_fork_repo itself also refuses to mutate state in dry mode. The unit
    # test calls sync_fork_repo directly, so it asserts against a pre-seeded
    # dict to catch any write through that seam.
    make_state_file(tmpdir)
    state = {}
    _install_git_fake(merge_code=0, unmerged=[])
    W._run_claude_sync = lambda workdir, prompt, label, fork, dry=False: (True, "ok")
    W._sync_commit_if_dirty = lambda workdir, msg: False
    pushes = []

    def fake_push(workdir, fork, source, dest, app_token, force=False):
        pushes.append(dest)
        return True, "pat push ok", False

    W._push_ref = fake_push
    before = dict(state)
    res, detail = W.sync_fork_repo("tok", "asepharyana/shiro-neko", "zakirkun/shiro-neko",
                                  "main", "main", "up1", 4, 26, state, W.sync_config("x"), dry=True)
    check("dry returns 'dry'", res == "dry", f"{res} {detail}")
    check("dry never pushes", not pushes, str(pushes))
    check("dry never writes state", state == before, f"{state} vs {before}")

    # conflict path in dry: failed resolution must NOT write state either
    state = {}
    _install_git_fake(merge_code=1, unmerged=["src/tools.ts"])
    W._run_claude_sync = lambda workdir, prompt, label, fork, dry=False: (False, "[INFRA] timed out")
    before = dict(state)
    res, detail = W.sync_fork_repo("tok", "f/x", "up/x", "main", "main", "up1", 4, 26, state,
                                   W.sync_config("x"), dry=True)
    check("dry conflict failure returns conflict-failed", res == "conflict-failed", f"{res} {detail}")
    check("dry conflict failure writes no state", state == before, f"{state} vs {before}")


# ── 4. conflicted merge resolved by Claude ────────────────────────────────
def test_conflict_resolved(tmpdir):
    print("4. conflicted merge handed to Claude Code, then pushed")
    make_state_file(tmpdir)
    state = {}
    _install_git_fake(merge_code=1, unmerged=["src/tools.ts", "src/ui/App.tsx"])
    labels = []

    def fake_claude(workdir, prompt, label, fork, dry=False):
        labels.append(label)
        # after resolution the tree is clean → _sync_finish_merge must be called
        W._sync_unmerged_files = lambda w: []
        check("conflict prompt forbids --ours/--theirs",
              "--ours/--theirs" in prompt and "rebase" in prompt)
        return True, "resolved"

    W._run_claude_sync = fake_claude
    finished = {"n": 0}
    # _install_git_fake defaults unmerged=[]; test 4's fake_claude flips it to []
    # mid-run — reset after the test so the leak does not poison test 5.
    # (test 5 deliberately runs a FAILED resolution and must see the merge
    #  still in conflict, not a bogus salvage.)

    def fake_finish(workdir):
        finished["n"] += 1
        return True, ""

    W._sync_finish_merge = fake_finish
    W._push_ref = lambda *a, **k: (True, "pat push ok", False)
    res, detail = W.sync_fork_repo("tok", "f/x", "up/x", "main", "main", "up1", 4, 26, state, W.sync_config("x"))
    check("status synced", res == "synced", f"{res} {detail}")
    check("conflict runner used", labels == ["hermes_sync_conflicts"], str(labels))
    check("merge completed once", finished["n"] == 1, str(finished))
    check("resolution noted in detail", "resolved 2 conflict" in detail, detail)
    # Reset the fakes: fake_finish + the unmerged flip leak into test 5.
    _install_git_fake()


def test_conflict_failed_skips_and_dedupes(tmpdir):
    print("5. failed conflict resolution → skip once, no retry at same upstream tip")
    make_state_file(tmpdir)
    state = {}
    _install_git_fake(merge_code=1, unmerged=["src/tools.ts"])
    W._run_claude_sync = lambda *a, **k: (False, "[INFRA] Hermes API server timed out")
    W._push_ref = lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not push after failed resolution"))
    res, detail = W.sync_fork_repo("tok", "f/x", "up/x", "main", "main", "up1", 4, 26, state, W.sync_config("x"))
    entry = state["f/x"]
    check("status conflict-failed", res == "conflict-failed", f"{res} {detail}")
    check("upstream tip recorded as attempted", entry["last_attempt_sha"] == "up1", str(entry))
    check("skip reason recorded", "timed out" in entry.get("skip_reason", ""), str(entry))
    check("pending_verify not set", not entry.get("pending_verify"), str(entry))


# ── 6. protected branch → PR path ─────────────────────────────────────────
def test_protected_branch_opens_pr(tmpdir):
    print("6. protected branch falls back to an upstream-sync PR")
    make_state_file(tmpdir)
    state = {}
    _install_git_fake(merge_code=0, unmerged=[])
    W._run_claude_sync = lambda *a, **k: (True, "ok")
    W._sync_commit_if_dirty = lambda *a, **k: False
    pushes = []

    def fake_push(workdir, fork, source, dest, app_token, force=False):
        pushes.append(dest)
        if dest.endswith("refs/heads/main"):
            return False, "pat: remote: error: GH006 protected branch", True
        return True, "pat push ok", False

    W._push_ref = fake_push
    W.open_sync_pr = lambda *a, **k: 42
    res, detail = W.sync_fork_repo("tok", "f/x", "up/x", "main", "main", "up1", 4, 26, state, W.sync_config("x"))
    check("status pr-opened", res == "pr-opened", f"{res} {detail}")
    check("direct push attempted first", pushes and pushes[0] == "refs/heads/main", str(pushes))
    check("no pending_verify on the PR path", not state["f/x"].get("pending_verify"), str(state["f/x"]))


# ── 7. CI verify / auto-revert ────────────────────────────────────────────
def test_verify_green_clears(tmpdir):
    print("7. verify_pending_syncs: green CI clears the watch")
    make_state_file(tmpdir)
    state = {"f/x": {"pending_verify": {"sha": "abc", "pre_merge_sha": "pre", "branch": "main",
                                       "pushed_at": time.time()}}}

    def fake_gh(method, path, token=None, json_data=None, retries=3):
        if "/commits/main" in path:
            return 200, [{"sha": "abc"}]
        if path.endswith("/check-runs"):
            return 200, {"check_runs": [{"name": "build", "status": "completed", "conclusion": "success"}]}
        return 200, {}

    W.gh_api = fake_gh
    reverted = []
    W._sync_revert_merge = lambda *a, **k: (reverted.append(a), (True, "reverted"))[1]
    lines = W.verify_pending_syncs(state, {"f/x": "tok"})
    check("green verifies", any("verified green" in l for l in lines), str(lines))
    check("watch cleared", state["f/x"]["pending_verify"] is None, str(state))
    check("no revert on green", not reverted, str(reverted))


def test_verify_red_reverts(tmpdir):
    print("8. verify_pending_syncs: red CI at our merge sha reverts it")
    make_state_file(tmpdir)
    state = {"f/x": {"pending_verify": {"sha": "abc", "pre_merge_sha": "pre", "branch": "main",
                                       "pushed_at": time.time()}}}

    def fake_gh(method, path, token=None, json_data=None, retries=3):
        if "/commits/main" in path:
            return 200, [{"sha": "abc"}]
        if path.endswith("/check-runs"):
            return 200, {"check_runs": [{"name": "build", "status": "completed", "conclusion": "failure"}]}
        return 200, {}

    W.gh_api = fake_gh
    reverted = []

    def fake_revert(token, fork, branch, pre_merge_sha, reason):
        reverted.append((fork, branch, pre_merge_sha, reason))
        return True, "reverted main to pre"

    W._sync_revert_merge = fake_revert
    W.post_sync_discord = lambda *a, **k: True
    lines = W.verify_pending_syncs(state, {"f/x": "tok"})
    check("revert invoked with the pre-merge sha",
          reverted and reverted[0][2] == "pre" and reverted[0][1] == "main", str(reverted))
    check("revert reported", any("reverted" in l for l in lines), str(lines))
    check("watch cleared after revert", state["f/x"]["pending_verify"] is None, str(state))


def test_verify_never_reverts_foreign_commits(tmpdir):
    print("9. verify_pending_syncs: never reverts when someone pushed on top")
    make_state_file(tmpdir)
    state = {"f/x": {"pending_verify": {"sha": "abc", "pre_merge_sha": "pre", "branch": "main",
                                       "pushed_at": time.time()}}}

    def fake_gh(method, path, token=None, json_data=None, retries=3):
        if "/commits/main" in path:
            return 200, [{"sha": "humancommit"}]
        if path.endswith("/check-runs"):
            return 200, {"check_runs": [{"name": "build", "status": "completed", "conclusion": "failure"}]}
        return 200, {}

    W.gh_api = fake_gh
    reverted = []
    W._sync_revert_merge = lambda *a, **k: (reverted.append(a), (True, "x"))[1]
    lines = W.verify_pending_syncs(state, {"f/x": "tok"})
    check("no revert when the tip moved", not reverted, str(reverted))
    check("tip change reported", any("moved past our merge" in l for l in lines), str(lines))
    check("watch cleared", state["f/x"]["pending_verify"] is None, str(state))


def test_verify_waits_for_running_ci(tmpdir):
    print("10. verify_pending_syncs: waits while checks run, respects no-CI grace")
    make_state_file(tmpdir)
    state = {"f/x": {"pending_verify": {"sha": "abc", "pre_merge_sha": "pre", "branch": "main",
                                       "pushed_at": time.time()}}}

    def fake_gh(method, path, token=None, json_data=None, retries=3):
        if "/commits/main" in path:
            return 200, [{"sha": "abc"}]
        if path.endswith("/check-runs"):
            return 200, {"check_runs": [{"name": "build", "status": "in_progress"}]}
        return 200, {}

    W.gh_api = fake_gh
    W.verify_pending_syncs(state, {"f/x": "tok"})
    check("running CI keeps the watch", state["f/x"]["pending_verify"] is not None, str(state))

    # no checks at all and young → still pending (check-runs lag)
    def fake_gh_none(method, path, token=None, json_data=None, retries=3):
        if "/commits/main" in path:
            return 200, [{"sha": "abc"}]
        return 200, {"check_runs": []}

    W.gh_api = fake_gh_none
    W.verify_pending_syncs(state, {"f/x": "tok"})
    check("fresh no-CI merge stays pending", state["f/x"]["pending_verify"] is not None, str(state))

    # old + no CI → stop watching
    state["f/x"]["pending_verify"]["pushed_at"] = time.time() - 3600
    W.verify_pending_syncs(state, {"f/x": "tok"})
    check("stale no-CI merge stops the watch", state["f/x"]["pending_verify"] is None, str(state))


# ── 11. fork discovery ────────────────────────────────────────────────────
def test_list_fork_repos():
    print("11. list_fork_repos returns only forks with a resolvable parent")
    def fake_gh(method, path, token=None, json_data=None, retries=3):
        if path == "/app/installations":
            return 200, [{"id": 1}]
        if path.startswith("/installation/repositories"):
            return 200, {"repositories": [
                {"full_name": "o/plain-repo", "fork": False},
                {"full_name": "o/fork-a", "fork": True},
                {"full_name": "o/fork-b", "fork": True},
            ]}
        if path == "/repos/o/fork-a":
            return 200, {"fork": True, "default_branch": "main", "parent": {"full_name": "up/a"}}
        if path == "/repos/o/fork-b":
            return 200, {"fork": True, "default_branch": "main"}  # parent stripped
        return 404, {}

    W.gh_api = fake_gh
    W.get_installation_token = lambda inst: "tok"
    forks = W.list_fork_repos()
    check("only the resolvable fork returned", forks == [("tok", "o/fork-a", "up/a", "main")], str(forks))


# ── 12. push-error classification ─────────────────────────────────────────
def test_push_error_classification():
    print("12. push error classification")
    check("GH006 → protected", W._is_protected_push_error(
        "remote: error: GH006: Protected branch update failed for refs/heads/main."))
    check("required status checks → protected", W._is_protected_push_error(
        "remote: error: Required status check \"ci\" is expected."))
    check("workflows permission detected", W._is_workflow_push_error(
        "! [remote rejected] main -> main (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)"))
    check("plain rejected push is not 'protected'", not W._is_protected_push_error(
        "fatal: could not read Username for 'https://github.com'"))


# ── 13. per-repo config override ──────────────────────────────────────────
def test_sync_config_override():
    print("13. per-repo config override merges over defaults")
    W.UPSTREAM_SYNC["repos"] = {"o/fork": {"interval_h": 6, "verify_ci": False}}
    cfg = W.sync_config("o/fork")
    check("override applied", cfg["interval_h"] == 6 and cfg["verify_ci"] is False, str(cfg))
    check("defaults preserved", cfg["resolve_conflicts"] is True, str(cfg))
    check("repos key not leaked", "repos" not in cfg, str(cfg))
    W.UPSTREAM_SYNC["repos"] = {}


# ── 14. Hermes API-server client ──────────────────────────────────────────
def test_hermes_api_client(tmpdir):
    """The worker's Hermes client must speak OpenAI chat-completions and map
    failures to [INFRA] strings the skip logic understands. Uses a real local
    HTTP server (no external network)."""
    print("14. Hermes API-server client (real HTTP round-trip)")
    import http.server
    import threading

    seen = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            seen["path"] = self.path
            seen["auth"] = self.headers.get("Authorization", "")
            seen["body"] = body
            if body.get("messages", [{}])[-1].get("content") == "boom":
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"upstream exploded"}}')
                return
            payload = json.dumps({
                "choices": [{"message": {"role": "assistant", "content": "resolved ok"}}]
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        W.API_SERVER_URL = f"http://127.0.0.1:{port}/v1"
        W._api_server_key_from_env = lambda: "test-key-0123456789"
        ok, text = W._hermes_api_post("resolve these conflicts", tmpdir)
        check("client posts to /v1/chat/completions", seen.get("path") == "/v1/chat/completions", str(seen.get("path")))
        check("client sends bearer auth", seen.get("auth") == "Bearer test-key-0123456789", str(seen.get("auth")))
        check("client sends openai messages shape",
              seen.get("body", {}).get("messages", [{}])[0].get("role") == "system", str(seen.get("body"))[:200])
        check("client caps turns via model_options",
              seen.get("body", {}).get("model_options", {}).get("max_turns") == W.AI_FIX_MAX_TURNS,
              str(seen.get("body", {}).get("model_options")))
        check("client returns agent text", ok and text == "resolved ok", f"{ok} {text!r}")

        ok2, err2 = W._hermes_api_post("boom", tmpdir)
        check("HTTP error mapped to [INFRA]", (not ok2) and err2.startswith("[INFRA]") and "500" in err2, err2)

        # missing key → INFRA, never a silent success
        W._api_server_key_from_env = lambda: ""
        saved = W.os.environ.pop("API_SERVER_KEY", None)
        try:
            ok3, err3 = W._hermes_api_post("x", tmpdir)
            check("missing key is [INFRA]", (not ok3) and "API_SERVER_KEY" in err3, err3)
        finally:
            if saved is not None:
                W.os.environ["API_SERVER_KEY"] = saved

        # unreachable port → INFRA with guidance
        W._api_server_key_from_env = lambda: "test-key-0123456789"
        W.API_SERVER_URL = "http://127.0.0.1:9/v1"
        ok4, err4 = W._hermes_api_post("x", tmpdir)
        check("unreachable server is [INFRA]", (not ok4) and "unreachable" in err4, err4)
    finally:
        srv.shutdown()
        srv.server_close()
        W.API_SERVER_URL = "http://127.0.0.1:8642/v1"


# ── 15. salvage + marker guard ────────────────────────────────────────────
def test_session_header_sent(tmpdir):
    """X-Hermes-Session-Id must be sent so each fork gets a fresh transcript."""
    print("17. X-Hermes-Session-Id is sent per fork")
    captured = {}

    class FakeResp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": "done"}}]}

    import httpx as _httpx
    import sys as _sys

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers, json):
            captured["headers"] = headers
            captured["url"] = url
            return FakeResp()

    _sys.modules["httpx"] = type("H", (), {"Client": FakeClient})
    ok, snippet = W._hermes_api_post("resolve", pathlib.Path(tmpdir), session_id="sync_x_y")
    check("session header sent", captured["headers"].get("X-Hermes-Session-Id") == "sync_x_y",
          str(captured.get("headers")))
    # Without session_id the header must be absent.
    captured.clear()
    ok2, _ = W._hermes_api_post("x", pathlib.Path(tmpdir), session_id=None)
    check("session header absent when not passed",
          "X-Hermes-Session-Id" not in captured["headers"], str(captured.get("headers")))
    _sys.modules["httpx"] = _httpx


# ── 15. salvage + marker guard ────────────────────────────────────────────
def test_salvage_on_agent_timeout(tmpdir):
    """A timed-out agent call must NOT throw away a merge the agent already
    finished — resolving many conflicts legitimately exceeds the HTTP timeout."""
    print("15. salvage a completed merge after an agent timeout")
    make_state_file(tmpdir)
    state = {}
    gitstate = _install_git_fake(merge_code=1, unmerged=[])  # agent resolved everything
    labels = []

    # The merge reports conflicts (so the worker enters the conflict path), but
    # by the time the agent call ends the agent HAS resolved everything — the
    # listing flips to empty when the fake runner is invoked.
    resolved = {"done": False}

    def fake_runner(workdir, prompt, label, fork, dry=False):
        labels.append(label)
        resolved["done"] = True          # agent finished the work…
        return False, "[INFRA] Hermes API server timed out after 2700s"  # …but the HTTP call timed out

    W._run_claude_sync = fake_runner
    W._sync_unmerged_files = lambda workdir: [] if resolved["done"] else ["src/tools.ts"]
    W._sync_has_conflict_markers = lambda workdir: []
    pushes = []
    W._push_ref = lambda workdir, fork, source, dest, app_token, force=False: (
        pushes.append(dest), (True, "pat push ok", False))[1]

    res, detail = W.sync_fork_repo("tok", "asepharyana/shiro-neko", "zakirkun/shiro-neko",
                                   "main", "main", "up1", 4, 26, state, W.sync_config("x"))
    check("timeout after a finished merge is salvaged, not failed",
          res == "synced", f"{res} {detail}")
    check("salvage still pushes", pushes and pushes[0] == "refs/heads/main", str(pushes))
    check("salvage note mentions the salvage", "salvag" in detail.lower(), detail)

    # …but a genuinely unfinished merge still fails and aborts.
    print("15b. unfinished merge after a timeout still fails")
    make_state_file(tmpdir)
    state2 = {}
    gitstate2 = _install_git_fake(merge_code=1, unmerged=["src/tools.ts"])
    W._sync_unmerged_files = lambda workdir: ["src/tools.ts"]
    W._sync_has_conflict_markers = lambda workdir: ["src/tools.ts"]
    res2, detail2 = W.sync_fork_repo("tok", "f/x", "up/x", "main", "main", "up1", 4, 26,
                                     state2, W.sync_config("x"))
    check("unfinished merge is still a failure", res2 == "conflict-failed", f"{res2} {detail2}")
    check("unfinished merge is aborted", gitstate2["aborts"] >= 1, str(gitstate2))


def test_finish_merge_blocks_leftover_markers(tmpdir):
    """`git add`ed files that still carry markers must never be committed."""
    print("16. _sync_finish_merge refuses files with leftover conflict markers")
    make_state_file(tmpdir)
    _install_git_fake()  # reset fakes; test 15b leaves a leaky spy behind
    W._sync_unmerged_files = lambda workdir: []
    W._sync_has_conflict_markers = lambda workdir: ["src/App.tsx"]
    commits = []
    real_git = W._sync_git

    def git_spy(args, workdir, timeout):
        if str(args[0]) == "commit":
            commits.append(list(args))
        return real_git(args, workdir, timeout)

    W._sync_git = git_spy
    ok, why = W._sync_finish_merge(pathlib.Path(tmpdir))
    check("marker guard blocks the commit", (not ok) and "marker" in why, f"{ok} {why}")
    check("no commit attempted", not commits, str(commits))
    W._sync_git = real_git
    W._sync_has_conflict_markers = lambda workdir: []
    W._sync_unmerged_files = lambda workdir: []


def main():
    with tempfile.TemporaryDirectory() as tmpdir:
        test_upstream_status_parsing()
        test_gating(tmpdir)
        test_clean_merge_synced(tmpdir)
        test_dry_run_is_pure(tmpdir)
        test_conflict_resolved(tmpdir)
        test_conflict_failed_skips_and_dedupes(tmpdir)
        test_protected_branch_opens_pr(tmpdir)
        test_verify_green_clears(tmpdir)
        test_verify_red_reverts(tmpdir)
        test_verify_never_reverts_foreign_commits(tmpdir)
        test_verify_waits_for_running_ci(tmpdir)
        test_list_fork_repos()
        test_push_error_classification()
        test_sync_config_override()
        test_hermes_api_client(pathlib.Path(tmpdir))
        test_session_header_sent(tmpdir)
        test_salvage_on_agent_timeout(tmpdir)
        test_finish_merge_blocks_leftover_markers(tmpdir)
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        print("failed: " + ", ".join(FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
