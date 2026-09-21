#!/usr/bin/env python3
"""
PR Queue Worker — Detect + AI Fix + Merge (every 5m)
=============================================
Batch-processes all open PRs:
  • No PRs → silent exit (zero token cost)
  • PR without review → trigger PR-Agent via fabricated webhook
  • PR with review → Claude Code AI fix (100 turns) → safety check → approve + merge 'pr-ai-fixer' cron (every 1h).
"""
import os, sys, json, time, re, hmac, hashlib, subprocess, shutil
from pathlib import Path

_os = os  # os.open/O_EXCL for the atomic worker lock

# ── PATH bootstrap ──
# Cron jobs run with a minimal PATH (no ~/.bun/bin, ~/.local/bin, nix profile),
# so bare `bun`/`gh`/`claude`/`uv` calls would FileNotFoundError. Prepend the
# user tool dirs once so subprocess resolution works in any environment.
_EXTRA_BIN_DIRS = [
    "/home/code/.bun/bin",
    "/home/code/.local/bin",
    "/home/code/.hermes/bin",
    "/usr/local/bin",
    "/nix/var/nix/profiles/default/bin",
]
os.environ["PATH"] = ":".join(_EXTRA_BIN_DIRS + [os.environ.get("PATH", "")])


def _load_env_file():
    """Load secret env vars from profile .env before module config resolves.
    The cron child env is scrubbed by Hermes; re-hydrate PR_AGENT_* + provider
    keys from the profile .env so the worker has its real secrets at import
    time. Existing env values win."""
    for dotenv_path in (
        Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / ".env",
        Path.home() / ".env",
    ):
        try:
            for line in dotenv_path.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key.startswith("PR_AGENT_") and not os.environ.get(key):
                    os.environ[key] = val
        except OSError:
            continue


_load_env_file()

# ── Config ──
# Secrets (WEBHOOK_SECRET, PRIVATE_KEY_PATH, APP_ID) come from environment
# variables so this file is safe to commit to a public repo. Locally the cron
# job's env is hydrated from ~/.hermes/.env (see _load_env_file below); the
# defaults are dev-only placeholders, never real secrets.
APP_ID = os.environ.get("PR_AGENT_APP_ID", "4319749")
PRIVATE_KEY_PATH = Path(os.environ.get("PR_AGENT_KEY_PATH", "/home/code/.hermes/keys/pr-agent-key.pem"))
WEBHOOK_SECRET = os.environ.get("PR_AGENT_WEBHOOK_SECRET", "")
PR_AGENT_WEBHOOK_URL = os.environ.get("PR_AGENT_WEBHOOK_URL", "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks")
BASE_URL = "https://api.github.com"
BOT_LOGIN = "mytheclipsebotreview"
LOCK_FILE = Path("/tmp/pr-queue-worker.lock")
FIX_STATE_FILE = Path("/tmp/pr-queue-fix-state.json")
TMP_BASE = Path("/tmp/pr-queue-work")

# ── AI Fix Config ──
AI_FIX_ENABLED = True
# Resolve Claude Code from PATH first (installed at ~/.local/bin/claude),
# falling back to the old hardcoded path. Using shutil.which avoids "CLI not found"
# skips when the binary exists in PATH but not at the hardcoded location.
CLAUDE_BIN = shutil.which("claude") or "/usr/local/bin/claude"
AI_FIX_MAX_TURNS = 100
AI_FIX_TIMEOUT = 600  # seconds per PR
TRACKING_DIR = Path("/tmp/pr-queue-pids")
AI_FIX_COST_CAP = 0.50  # max budget USD per fix session


def _claude_env():
    """Build the env for the Claude Code subprocess.

    The cron child env is scrubbed by Hermes (provider keys like
    ANTHROPIC_API_KEY / OMNIROUTE_API_KEY are stripped by
    build_subprocess_env), so `claude -p` would exit with
    "Not logged in · Please run /login". Re-hydrate the Anthropic
    credentials from the profile .env so Claude Code can reach 9router
    non-interactively. Existing env values win over the file.
    """
    env = os.environ.copy()
    # Hermes venv python used by cron strips provider keys, but model/route
    # env vars below leak through untouched — they are NOT secrets.
    missing = [k for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL") if not env.get(k)]
    if missing:
        # Prefer the real profile .env (root gateway) then the code-user copy.
        for dotenv_path in (
            Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / ".env",
            Path.home() / ".env",
        ):
            try:
                for line in dotenv_path.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key in missing and not env.get(key):
                        env[key] = val
                        if key == "ANTHROPIC_BASE_URL" and val.endswith("/v1"):
                            env["ANTHROPIC_URL"] = val
                missing = [k for k in missing if not env.get(k)]
                if not missing:
                    break
            except OSError:
                continue
    return env


# ── Helpers ──
log = print  # direct print for immediate output (debug only)

import pathlib  # noqa: F401 (flush_log reads webhook config path)
BUFFER = []
def flush_log():
    # Route the PR-queue run report to the pr-agent-ops Discord webhook when running
    # unattended (cron, no TTY), keeping the chat free of bot messages. Only when a
    # human runs it interactively do we print to stdout (debug). 2026-08-07.
    report = "\n".join(BUFFER)
    if not report:
        return
    if sys.stdin.isatty():
        print(report)
        return
    try:
        cfg = json.loads((pathlib.Path.home() / ".hermes/.ops-webhooks.json").read_text())
        url = cfg.get("pr-agent-ops")
        if url:
            import httpx
            with httpx.Client(timeout=15) as client:
                client.post(url, json={
                    "username": "PR-Agent Ops",
                    "embeds": [{
                        "title": "🔀 PR Queue Worker Report",
                        "description": report[:4000],
                        "color": 0x5865F2,
                    }],
                })
    except Exception:
        pass


def get_jwt():
    import jwt as pyjwt
    return pyjwt.encode({"iat": int(time.time()) - 60, "exp": int(time.time()) + 600, "iss": APP_ID},
                         PRIVATE_KEY_PATH.read_text(), algorithm="RS256")

def gh_api(method, path, token=None, json_data=None, retries=3):
    import httpx
    headers = {"Accept": "application/vnd.github.v3+json"}
    headers["Authorization"] = f"token {token}" if token else f"Bearer {get_jwt()}"
    last_exc = None
    for attempt in range(retries):
        try:
            # Fresh client per attempt → re-resolves DNS (transient EAI_AGAIN safe)
            with httpx.Client(timeout=30) as client:
                r = client.request(method, f"{BASE_URL}{path}", headers=headers, json=json_data)
                try: return r.status_code, r.json()
                except: return r.status_code, {}
        except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout, httpx.ReadError, httpx.WriteError) as e:
            last_exc = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)  # 1s, 2s backoff
                continue
            # fall through to generic handler below for final attempt logging
        except httpx.HTTPError as e:
            # catch-all for other httpx transport/protocol errors (mapped httpcore errors)
            last_exc = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
        except Exception as e:  # safety net: never crash the cron on transient transport error
            last_exc = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
    log(f"[gh_api] connect failed after {retries} attempts: {last_exc}")
    return 0, {}

def get_installation_token(inst_id):
    _, data = gh_api("POST", f"/app/installations/{inst_id}/access_tokens")
    return data.get("token", "")


# ── Locking ──
def get_lock():
    # Atomic O_EXCL claim; a stale file from a dead PID is recycled so a
    # crash/kill -9 doesn't wedge the cron job.
    fd = None
    try:
        fd = _os.open(LOCK_FILE, _os.O_CREAT | _os.O_EXCL | _os.O_WRONLY, 0o644)
        _os.write(fd, str(_os.getpid()).encode())
        _os.close(fd)
        return True
    except FileExistsError:
        try:
            pid = int(LOCK_FILE.read_text().strip())
            if Path(f"/proc/{pid}").exists():
                return False
        except (ValueError, OSError):
            pass
        # Stale lock: PID dead. Safe to steal (no concurrent holder).
        LOCK_FILE.unlink(missing_ok=True)
        try:
            fd = _os.open(LOCK_FILE, _os.O_CREAT | _os.O_EXCL | _os.O_WRONLY, 0o644)
            _os.write(fd, str(_os.getpid()).encode())
            _os.close(fd)
            return True
        except FileExistsError:
            return False
    finally:
        if fd is not None:
            try:
                _os.close(fd)
            except OSError:
                pass

def release_lock():
    LOCK_FILE.unlink(missing_ok=True)

def load_fix_state():
    """Load state map {repo_full: {pr_num: {"sha": last_head_sha, "skip_reason": str|None,
    "notified": bool}}} — records fixed SHA, permanent skip reasons, and
    whether the skip was already notified (dedupe)."""
    if FIX_STATE_FILE.exists():
        try:
            return json.loads(FIX_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}

def save_fix_state(state):
    """Persist state map."""
    FIX_STATE_FILE.write_text(json.dumps(state))

def _pr_entry(state, repo_full, pr_num):
    """Get the per-PR entry dict. Migrates the legacy format
    {repo: {pr: "sha"}} (bare string) to the new dict form in place."""
    repo_state = state.setdefault(repo_full, {})
    val = repo_state.get(str(pr_num))
    if isinstance(val, str):
        # legacy: {"pr": "sha"} → {"sha": "sha"}
        repo_state[str(pr_num)] = {"sha": val, "notified": False}
    return repo_state.setdefault(str(pr_num), {})

def already_fixed(state, repo_full, pr_num, head_sha):
    """True if this PR was already fixed (or permanently skipped) at this SHA."""
    entry = _pr_entry(state, repo_full, pr_num)
    return entry.get("sha") == head_sha

def mark_fixed(state, repo_full, pr_num, head_sha):
    """Mark PR as fixed at given SHA."""
    entry = _pr_entry(state, repo_full, pr_num)
    entry["sha"] = head_sha
    entry.pop("skip_reason", None)
    entry["notified"] = False
    save_fix_state(state)

def get_skip_reason(state, repo_full, pr_num, head_sha):
    """Return the permanent skip reason for this PR+SHA, or None."""
    entry = _pr_entry(state, repo_full, pr_num)
    if entry.get("sha") == head_sha:
        return entry.get("skip_reason")
    return None

def mark_skip(state, repo_full, pr_num, head_sha, reason):
    """Permanently skip AI-fix/merge for this PR at this SHA with a reason.
    Prevents infinite re-attempts every cron tick on the same PR."""
    entry = _pr_entry(state, repo_full, pr_num)
    entry["sha"] = head_sha
    entry["skip_reason"] = reason
    save_fix_state(state)
    return entry

def was_skip_notified(state, repo_full, pr_num, head_sha):
    """True if the skip notification for this PR+SHA was already sent."""
    entry = _pr_entry(state, repo_full, pr_num)
    return bool(entry.get("notified")) and entry.get("sha") == head_sha

def mark_skip_notified(state, repo_full, pr_num, head_sha):
    entry = _pr_entry(state, repo_full, pr_num)
    entry["notified"] = True
    save_fix_state(state)

# ── GitHub Data ──
def gather_open_prs():
    results = []
    _, installs = gh_api("GET", "/app/installations")
    if not isinstance(installs, list):
        return results
    for inst in installs:
        token = get_installation_token(inst["id"])
        if not token:
            continue
        _, repos = gh_api("GET", "/installation/repositories", token=token)
        for repo in repos.get("repositories", []):
            _, prs = gh_api("GET", f"/repos/{repo['full_name']}/pulls?state=open&per_page=20&sort=updated", token=token)
            if isinstance(prs, list):
                for pr in prs:
                    results.append((token, repo["full_name"], pr))
    return results


# ── PR-Agent Review Detection ──
def find_review_comment(token, repo_full, pr_num):
    _, comments = gh_api("GET", f"/repos/{repo_full}/issues/{pr_num}/comments", token=token)
    if not isinstance(comments, list):
        return None
    for c in comments:
        login = c.get("user", {}).get("login", "")
        if BOT_LOGIN in login:
            body = c.get("body", "")
            if "PR Reviewer Guide" in body:
                return body
    return None


def find_trivial_noreview_marker(token, repo_full, pr_num):
    """True if PR-Agent already decided this PR has no code diff to review
    (e.g. dependabot lockfile-only PRs). Such PRs never produce a 'PR Reviewer
    Guide'; they get 'PR Code Suggestions: No code suggestions found' instead.
    Returning True lets the worker treat it as 'reviewed' to avoid re-triggering
    every 5 minutes (which spammed duplicate comments on GMW #22 2026-08-28)."""
    _, comments = gh_api("GET", f"/repos/{repo_full}/issues/{pr_num}/comments", token=token)
    if not isinstance(comments, list):
        return False
    for c in comments:
        login = c.get("user", {}).get("login", "")
        if BOT_LOGIN in login:
            body = c.get("body", "")
            if "PR Code Suggestions" in body and "No code suggestions found" in body:
                return True
    return False


# ── Safety Analysis ──
def analyze_review_safety(body):
    if not body:
        return False, ["❌ No review"], 0
    reasons, score = [], 5

    for pat in ["Failed to generate", "Error during", "RetryError", "traceback", "Internal Server Error"]:
        if re.search(pat, body, re.IGNORECASE):
            return False, [f"❌ Review error: {pat}"], 0

    sec_clear = bool(re.search(r'🔒.*No security concerns identified', body))
    sec_danger = bool(re.search(r'🔒.*(?<!No )Security concern(?!s identified)', body, re.IGNORECASE))
    if sec_clear:
        reasons.append("✅ Security: clean"); score += 2
    elif sec_danger:
        return False, ["🔴 Security concern — blocking"], 0
    else:
        reasons.append("⚠️ Security unclear"); score -= 1

    issues_clear = bool(re.search(r'⚡.*No major (issues|problems) detected', body))
    issues_danger = bool(re.search(r'⚡.*(breaking change|major issue|critical|problem detected)', body, re.IGNORECASE))
    if issues_clear:
        reasons.append("✅ No major issues"); score += 2
    elif issues_danger:
        return False, ["🔴 Major issues — blocking"], 0
    else:
        reasons.append("⚠️ Issues unclear"); score -= 1

    test_missing = bool(re.search(r'🧪.*(Test required|tests? missing|no tests found)', body, re.IGNORECASE))
    test_irrelevant = bool(re.search(r'🧪.*No relevant tests', body))
    if test_missing and not test_irrelevant:
        reasons.append("⚠️ Tests missing"); score -= 1

    effort_m = re.search(r'⏱️.*?(\d+)', body)
    if effort_m and int(effort_m.group(1)) >= 4:
        reasons.append(f"⚠️ Large PR (effort: {effort_m.group(1)})"); score -= 1
    else:
        score += 1

    score = max(0, min(10, score))
    return score >= 6, reasons, score


# ── CI Check ──
def check_ci_passed(token, repo_full, sha):
    _, data = gh_api("GET", f"/repos/{repo_full}/commits/{sha}/check-runs", token=token)
    checks = data.get("check_runs", []) if isinstance(data, dict) else []
    if not checks:
        return True, "✅ No CI configured — skipping CI gate"
    failed = [c for c in checks if c.get("conclusion") == "failure"]
    pending = [c for c in checks if c.get("status") != "completed"]
    if failed:
        return False, f"CI FAILED: {', '.join(c['name'] for c in failed[:3])}"
    if pending:
        return False, f"CI pending: {', '.join(c['name'] for c in pending[:3])}"
    return True, f"✅ {len(checks)} checks green"


# ── Actions ──
def trigger_pr_agent_review(repo_full, pr_num, title, head_sha, head_ref, base_ref):
    import httpx
    # IMPORTANT (2026-08-28 fix): PR-Agent's `_check_pull_request_event` requires the
    # `pull_request.url` field — without it the webhook is acknowledged HTTP 200 but
    # rejected with "Invalid PR event: action='opened' api_url=''" and NO review runs.
    # Real GitHub webhooks always carry `url`, `state`, `labels`, `draft` and the
    # `installation.id` (which feeds the installation token lookup). Keep them in the
    # synthetic payload so the fabricated webhook behaves like a real one.
    install_id = 0
    try:
        # best-effort: use the installation id from the current PR's repo context
        _, installs = gh_api("GET", "/app/installations")
        if isinstance(installs, list):
            for inst in installs:
                _, repos = gh_api("GET", f"/installation/repositories?per_page=100", token=get_installation_token(inst["id"]))
                fulls = [r.get("full_name") for r in repos.get("repositories", []) if isinstance(r, dict)] if isinstance(repos, dict) else []
                if repo_full in fulls:
                    install_id = inst["id"]
                    break
    except Exception:
        install_id = 0
    payload = json.dumps({
        "action": "opened", "number": pr_num,
        "sender": {"login": "mytheclipsebotreview", "id": 0, "type": "Bot"},
        "installation": {"id": install_id},
        "pull_request": {
            "url": f"https://api.github.com/repos/{repo_full}/pulls/{pr_num}",
            "number": pr_num, "title": title,
            "state": "open", "draft": False, "labels": [],
            "head": {"sha": head_sha, "ref": head_ref},
            "base": {"ref": base_ref, "repo": {"full_name": repo_full}}
        },
        "repository": {"full_name": repo_full}
    })
    sig = "sha256=" + hmac.new(WEBHOOK_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(PR_AGENT_WEBHOOK_URL, content=payload, headers={
                "Content-Type": "application/json", "x-github-event": "pull_request",
                "x-hub-signature-256": sig, "x-github-delivery": f"cron-{int(time.time())}-{pr_num}",
            })
            return r.status_code
    except Exception as e:
        return f"error: {e}"

def approve_pr(token, repo_full, pr_num):
    status, _ = gh_api("POST", f"/repos/{repo_full}/pulls/{pr_num}/reviews", token=token,
                       json_data={"event": "APPROVE", "body": "✅ Auto-approved by PR Queue Worker."})
    return status

def merge_pr(token, repo_full, pr_num, sha):
    payload = {"commit_title": f"Auto-merge PR #{pr_num}", "merge_method": "merge", "sha": sha}
    status, data = gh_api("PUT", f"/repos/{repo_full}/pulls/{pr_num}/merge", token=token, json_data=payload)
    if status == 403:
        # GitHub Apps without the `workflows` permission cannot merge a PR that
        # changes .github/workflows/* — the merge IS a push of those files. Retry
        # as the repo owner (gh CLI PAT), which can, and report that result.
        pat = _fetch_gh_token()
        if pat:
            return gh_api("PUT", f"/repos/{repo_full}/pulls/{pr_num}/merge", token=pat, json_data=payload)
    return status, data

def post_discord_notification(repo_full, pr_num, status, summary="", score="", url=""):
    """Fire-and-forget Discord notification via pr-agent server internal endpoint."""
    import httpx
    notify_url = os.environ.get("PR_AGENT_NOTIFY_URL", "http://127.0.0.1:4023/api/v1/notify_review")
    try:
        with httpx.Client(timeout=5) as client:
            client.post(notify_url, json={
                "repo": repo_full, "pr": pr_num, "status": status,
                "summary": summary[:500], "score": str(score), "url": url,
            })
    except Exception:
        pass

def notify_skip_once(state, repo_full, pr_num, head_sha, reason):
    """Send a Discord skip notification exactly ONCE per PR+head_sha+reason.
    Returns True if a notification was sent, False if it was already sent."""
    if was_skip_notified(state, repo_full, pr_num, head_sha):
        return False
    post_discord_notification(
        repo_full, pr_num, "skipped",
        summary=f"⏭️ Skipped: {reason} — will not retry until the PR head changes",
        url=f"https://github.com/{repo_full}/pull/{pr_num}",
    )
    mark_skip_notified(state, repo_full, pr_num, head_sha)
    return True


# ── REAL AI AUTO-FIX via Claude Code ──



# ── Toolchain Pin Guards (2026-09-21) ──
# Dependabot PRs that bump a pinned toolchain package are CLOSED immediately
# instead of being AI-fixed / CI-waited / merged. The pins are exact-version in
# package.json + `ignore` rules in .github/dependabot.yml + branch protection,
# so any such PR is a policy violation no matter what CI says.
# Map: repo_full -> { package_name: allowed_major_or_None(any-major-ok) }
# None = package may move within its pinned major; only forbid explicit false.
TOOLCHAIN_PINS = {
    "asepharyana/nextjs-template": {
        "typescript": 6,
        "eslint": 9,
        "eslint-config-next": 16,
        "eslint-plugin-react": 7,
        "@tsparticles/react": 3,
        "@tsparticles/engine": 3,
        "@tsparticles/slim": 3,
    },
}


def toolchain_pin_violation(repo_full, title):
    """Return (package, old_ver, new_ver) if a dependabot PR bumps a pinned
    toolchain package to a disallowed major, else None.
    Title format: 'chore(deps): bump X from A to B' or
    'chore(deps-dev): bump X from A to B'."""
    pins = TOOLCHAIN_PINS.get(repo_full)
    if not pins:
        return None
    m = re.match(r"chore\(deps(?:-dev)?\): bump ([^ ]+) from ([0-9.]+) to ([0-9.]+)", str(title))
    if not m:
        return None
    pkg, old_ver, new_ver = m.group(1), m.group(2), m.group(3)
    allowed_major = pins.get(pkg)
    if allowed_major is None:
        return None
    new_major = int(new_ver.split(".")[0])
    if new_major != allowed_major:
        return (pkg, old_ver, new_ver)
    return None


def close_toolchain_pr(token, repo_full, pr_num, pkg, old_ver, new_ver):
    """Close a dependabot PR that violates the toolchain pin, with an
    explanatory comment. Returns (closed: bool, comment_status: int)."""
    body = (
        f"⛔ Auto-closed by PR Queue Worker — **toolchain pin violation**.\n\n"
        f"`{pkg}` {old_ver} → {new_ver} bumps a pinned toolchain package "
        f"whose major must stay as declared in `package.json` (exact pin) and "
        f"`.github/dependabot.yml` (`ignore` rule). The vendored Aceternity "
        f"components and the CI stack are validated against this major only.\n\n"
        f"This PR is a policy violation — it will **not** be merged. "
        f"If the pin needs changing, do it deliberately via a regular PR."
    )
    # Post comment first (best-effort), then close
    _, cdata = gh_api("POST", f"/repos/{repo_full}/issues/{pr_num}/comments",
                      token=token, json_data={"body": body})
    status, data = gh_api("PATCH", f"/repos/{repo_full}/pulls/{pr_num}",
                          token=token, json_data={"state": "closed"})
    return status, cdata


def close_stale_ci_pr(token, repo_full, pr_num, title, ci_msg):
    """Close a dependabot PR whose CI has been failing for days (incompatible
    bump — it will never pass). Returns (status, comment_status)."""
    body = (
        f"⛔ Auto-closed by PR Queue Worker — **stale failing CI**.\n\n"
        f"CI has been failing for {STALE_CI_CLOSE_DAYS}+ days on this "
        f"dependency bump: `{ci_msg}`. The update is incompatible with the "
        f"current stack and will not be merged; the worker would otherwise "
        f"wait on it forever.\n\n"
        f"If this dependency genuinely needs updating, open a proper PR with "
        f"the required code changes so CI can pass."
    )
    _, cdata = gh_api("POST", f"/repos/{repo_full}/issues/{pr_num}/comments",
                      token=token, json_data={"body": body})
    status, data = gh_api("PATCH", f"/repos/{repo_full}/pulls/{pr_num}",
                          token=token, json_data={"state": "closed"})
    return status, cdata


# Dependabot PRs stuck with failing CI for > STALE_CI_CLOSE_DAYS get closed
# (they will never pass; the bump is incompatible with the stack). This stops
# the worker from forever printing "Waiting for green CI" on the same PR.
STALE_CI_CLOSE_DAYS = 2


def is_trivial_pr(title, author):
    """Skip AI fix for trivial PRs (dependabot bumps, docs-only, etc.)"""
    trivial_kw = ["dependabot", "update", "bump", "chore(deps)", "pin dependencies",
               "update version", "docs:", "readme", "changelog"]
    title_lower = str(title).lower()
    for kw in trivial_kw:
        if kw in title_lower:
            return True
    return False

def _fetch_gh_token():
    """Get a fresh GitHub PAT from gh CLI."""
    import subprocess
    try:
        r = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""

def _repo_has_bun_lock(token, repo_full, sha):
    """True if the repo's tree at `sha` contains a bun.lock (root or any workspace)."""
    import httpx
    try:
        with httpx.Client(timeout=15) as client:
            r = client.get(
                f"https://api.github.com/repos/{repo_full}/git/trees/{sha}?recursive=1",
                headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
            )
            if r.status_code == 200:
                tree = r.json()
                for item in tree.get("tree", []):
                    if "bun.lock" in item.get("path", ""):
                        return True
    except Exception:
        pass
    return False


def fix_uv_lock_for_trivial_pr(repo_full, pr_num, title, head_sha, head_ref, base_ref, token):
    """
    For trivial PRs (dependabot) with CI failure on uv.lock check:
    clone branch, run `uv lock`, commit & push the updated lockfile.
    Returns (success: bool, summary: str).
    """
    import subprocess
    workdir = TMP_BASE / (str(repo_full).replace("/", "_") + "_lockfix_" + str(pr_num))

    if workdir.exists():
        subprocess.run(["rm", "-rf", str(workdir)], timeout=30)
    workdir.mkdir(parents=True, exist_ok=True)

    # Use gh token for auth (reliable PAT)
    gh_token = _fetch_gh_token()
    if not gh_token:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "no gh token"

    clone_url = f"https://x-access-token:{gh_token}@github.com/{repo_full}.git"
    r = subprocess.run(
        ["git", "clone", clone_url, str(workdir), "--branch", head_ref, "--depth", "5"],
        capture_output=True, text=True, timeout=60
    )
    if r.returncode != 0:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "clone failed"

    subprocess.run(["git", "config", "user.name", "mytheclipsebotreview"], cwd=str(workdir), capture_output=True, timeout=10)
    subprocess.run(["git", "config", "user.email", "bot@users.noreply.github.com"], cwd=str(workdir), capture_output=True, timeout=10)

    # Fetch base branch and merge to match CI merge-state
    subprocess.run(["git", "fetch", "origin", base_ref, "--depth", "5"],
                   capture_output=True, text=True, timeout=30, cwd=str(workdir))
    merge_r = subprocess.run(["git", "merge", f"origin/{base_ref}", "--no-edit"],
                             capture_output=True, text=True, timeout=30, cwd=str(workdir))
    if merge_r.returncode != 0:
        # Merge failed (conflicts) — abort
        subprocess.run(["git", "merge", "--abort"], capture_output=True, timeout=15, cwd=str(workdir))
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, f"merge conflict with {base_ref}"

    # Run uv lock
    r2 = subprocess.run(["uv", "lock"], capture_output=True, text=True, timeout=180, cwd=str(workdir))
    if r2.returncode != 0:
        # uv lock failed — likely dependency conflict, PR is unmergeable
        stderr_last = r2.stderr[-300:] if len(r2.stderr) > 300 else r2.stderr
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, f"uv lock failed: {stderr_last[:100]}"

    # Check if uv.lock actually changed
    r3 = subprocess.run(["git", "diff", "--name-only"], capture_output=True, text=True, timeout=15, cwd=str(workdir))
    changed = [f.strip() for f in r3.stdout.split("\n") if f.strip()]

    if not changed:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "no change (uv.lock already consistent)"

    # Only commit if uv.lock changed (ignore .config/ etc.)
    lock_changed = any("uv.lock" in f for f in changed)
    if not lock_changed:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, f"unexpected files changed: {changed[:3]}"

    subprocess.run(["git", "add", "-A"], capture_output=True, timeout=15, cwd=str(workdir))
    cr = subprocess.run(
        ["git", "commit", "-m", "chore: refresh uv.lock after dependabot bump [skip ci]"],
        capture_output=True, text=True, timeout=30, cwd=str(workdir)
    )
    if cr.returncode != 0:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, f"commit failed: {cr.stderr[:100]}"

    pr = subprocess.run(["git", "push", "origin", f"HEAD:{head_ref}"],
                        capture_output=True, text=True, timeout=60, cwd=str(workdir))
    subprocess.run(["rm", "-rf", str(workdir)], timeout=10)

    if pr.returncode == 0:
        return True, "uv.lock regenerated and pushed"
    return False, f"push failed: {pr.stderr[:100]}"


def fix_bun_lock_for_trivial_pr(repo_full, pr_num, title, head_sha, head_ref, base_ref, token):
    """
    For trivial PRs (dependabot) where CI fails on `bun install --frozen-lockfile`:
    clone branch, run `bun install` to refresh bun.lock, commit & push only if
    bun.lock changed.

    Root cause (2026-08-29): dependabot bumps package.json deps but bun.lock
    is computed/resolved at install time by bun 1.3.14 differently than when
    the lockfile was last committed, so CI's --frozen-lockfile rejects the PR
    even though the code is correct. Fix = re-sync bun.lock on the PR branch.

    Returns (success: bool, summary: str).
    """
    import subprocess
    workdir = TMP_BASE / (str(repo_full).replace("/", "_") + "_bunfix_" + str(pr_num))

    if workdir.exists():
        subprocess.run(["rm", "-rf", str(workdir)], timeout=30)
    workdir.mkdir(parents=True, exist_ok=True)

    gh_token = _fetch_gh_token()
    if not gh_token:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "no gh token"

    clone_url = "https://x-access-token:" + gh_token + "@github.com/" + str(repo_full) + ".git"
    r = subprocess.run(
        ["git", "clone", clone_url, str(workdir), "--branch", head_ref],
        capture_output=True, text=True, timeout=60
    )
    if r.returncode != 0:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "clone failed: " + str(r.stderr[:200])

    subprocess.run(["git", "config", "user.name", "mytheclipsebotreview"], cwd=str(workdir), capture_output=True, timeout=10)
    subprocess.run(["git", "config", "user.email", "bot@users.noreply.github.com"], cwd=str(workdir), capture_output=True, timeout=10)

    # Merge base branch so lockfile matches the CI merge-state
    subprocess.run(["git", "fetch", "origin", base_ref], capture_output=True, text=True, timeout=30, cwd=str(workdir))
    merge_r = subprocess.run(["git", "merge", f"origin/{base_ref}", "--no-edit", "--no-ff"],
                             capture_output=True, text=True, timeout=30, cwd=str(workdir))
    if merge_r.returncode != 0:
        subprocess.run(["git", "merge", "--abort"], capture_output=True, timeout=15, cwd=str(workdir))
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, f"merge conflict with {base_ref}"

    # Check if bun.lock needs sync
    frozen = subprocess.run(["bun", "install", "--frozen-lockfile"], capture_output=True, text=True, timeout=120, cwd=str(workdir))
    if frozen.returncode == 0:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "bun.lock already consistent with package.json (CI failure elsewhere)"

    # Sync bun.lock
    sync = subprocess.run(["bun", "install"], capture_output=True, text=True, timeout=180, cwd=str(workdir))
    if sync.returncode != 0:
        stderr_last = sync.stderr[-300:] if len(sync.stderr) > 300 else sync.stderr
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, f"bun install sync failed: {stderr_last[:100]}"

    # Only commit if bun.lock changed
    diff = subprocess.run(["git", "diff", "--name-only"], capture_output=True, text=True, timeout=15, cwd=str(workdir))
    changed = [f.strip() for f in diff.stdout.split("\n") if f.strip()]
    lock_changed = any("bun.lock" in f for f in changed)
    if not lock_changed:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, f"bun install ran but bun.lock unchanged (unexpected files: {changed[:3]})"

    subprocess.run(["git", "add", "bun.lock"], capture_output=True, timeout=15, cwd=str(workdir))
    cr = subprocess.run(
        ["git", "commit", "-m", "chore: sync bun.lock after dependabot bump"],
        capture_output=True, text=True, timeout=30, cwd=str(workdir)
    )
    if cr.returncode != 0 and "nothing to commit" not in cr.stderr:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, f"commit failed: {cr.stderr[:100]}"

    pr = subprocess.run(["git", "push", "origin", f"HEAD:{head_ref}"],
                        capture_output=True, text=True, timeout=60, cwd=str(workdir))
    subprocess.run(["rm", "-rf", str(workdir)], timeout=10)

    if pr.returncode == 0:
        return True, "bun.lock regenerated and pushed"
    return False, f"push failed: {pr.stderr[:100]}"


def kill_orphaned_claude(repo_full, pr_num):
    """Kill any previously-running Claude process on this PR."""
    pid_file = TRACKING_DIR / (str(repo_full).replace("/", "_") + "_" + str(pr_num) + ".pid")
    if pid_file.exists():
        try:
            old_pid = int(pid_file.read_text().strip())
            if Path(f"/proc/{old_pid}").exists():
                import signal
                os.kill(old_pid, signal.SIGTERM)
                import time
                time.sleep(2)
                if Path(f"/proc/{old_pid}").exists():
                    os.kill(old_pid, signal.SIGKILL)
        except (ValueError, OSError, ProcessLookupError):
            pass
    TRACKING_DIR.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()))

def check_pr_still_valid(token, repo_full, pr_num, original_sha):
    """Re-fetch PR. Returns (is_valid, head_sha, mergeable, error_reason).
    False if someone merged/closed/pushed new commits."""
    status, data = gh_api("GET", f"/repos/{repo_full}/pulls/{pr_num}", token=token)
    if status != 200 or not isinstance(data, dict):
        return False, "", None, "failed to fetch PR"
    if data.get("state") != "open" or data.get("merged", False):
        return False, "", None, "PR was closed/merged"
    new_sha = data.get("head", {}).get("sha", "")
    if new_sha and new_sha != original_sha:
        return False, new_sha, data.get("mergeable"), "PR was updated by someone else"
    return True, new_sha, data.get("mergeable"), ""

def run_ai_fix(repo_full, pr_num, title, head_sha, head_ref, base_ref, token):
    """
    REAL AI auto-fix: clone PR branch, run Claude Code for quality improvements,
    commit + push fixes. Uses Claude Code CLI with real tool use.
    """
    import subprocess
    workdir = TMP_BASE / (str(repo_full).replace("/", "_") + "_" + str(pr_num))
    
    if workdir.exists():
        subprocess.run(["rm", "-rf", str(workdir)], timeout=30)
    workdir.mkdir(parents=True, exist_ok=True)

    # Clone the PR branch
    clone_url = "https://x-access-token:" + str(token) + "@github.com/" + str(repo_full) + ".git"
    r = subprocess.run(
        ["git", "clone", clone_url, str(workdir), "--branch", head_ref, "--depth", "20"],
        capture_output=True, text=True, timeout=60
    )
    if r.returncode != 0:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "clone failed: " + str(r.stderr[:200])
    # Set git identity to avoid AI using default names
    subprocess.run(["git", "config", "user.name", "mytheclipsebotreview"], cwd=str(workdir), capture_output=True, timeout=10)
    subprocess.run(["git", "config", "user.email", "bot@users.noreply.github.com"], cwd=str(workdir), capture_output=True, timeout=10)

    # Fetch base branch so we can diff properly (shallow clone doesn't include it)
    subprocess.run(
        ["git", "fetch", "origin", str(base_ref), "--depth", "10"],
        capture_output=True, text=True, timeout=30, cwd=str(workdir)
    )

    # Get files changed vs base via git diff (3-dot notation)
    r2 = subprocess.run(
        ["git", "diff", "--name-only", "origin/" + str(base_ref) + "...", "--diff-filter=ACMR"],
        capture_output=True, text=True, timeout=15, cwd=str(workdir)
    )
    changed_files = [f.strip() for f in r2.stdout.split("\n") if f.strip()]

    # Fallback: if git diff empty, try GitHub API for PR changed files
    if not changed_files:
        try:
            import httpx
            with httpx.Client(timeout=15) as client:
                resp = client.get(
                    f"https://api.github.com/repos/{repo_full}/pulls/{pr_num}/files?per_page=50",
                    headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
                )
                if resp.status_code == 200:
                    pr_files = resp.json()
                    changed_files = [f["filename"] for f in pr_files if f.get("status") in ("added", "modified", "renamed", "copied")]
        except Exception:
            pass

    if not changed_files:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "no changed files to fix"

    # Build Claude Code prompt
    file_list = "\n".join("  - " + f for f in changed_files[:30])
    if len(changed_files) > 30:
        file_list += "\n  ... and " + str(len(changed_files) - 30) + " more"

    prompt = (
        'You are on the PR #' + str(pr_num) + ' branch of ' + str(repo_full) + ': "' + str(title) + '"\n\n'
        'Files changed in this PR:\n'
        + file_list + '\n\n'
        'Your task:\n'
        '1. FIRST, try to merge the base branch to resolve any stale conflicts:\n'
        '     git fetch origin ' + str(base_ref) + '\n'
        '     git merge origin/' + str(base_ref) + ' --no-edit\n'
        '   If there are merge conflicts, resolve them intelligently\n'
        '2. THEN improve code quality of ALL changed files:\n'
        '   - Fix naming, DRY up repeated logic, add error handling\n'
        '   - Add type hints / type annotations where missing\n'
        '   - Fix anti-patterns, improve structure, add docstrings\n'
        '3. Commit ALL changes with EXACT message:\n'
        '     git add -A && git commit --message="fix: auto-fix code quality [skip ci]"\n'
        '4. Push:\n'
        '     git push origin HEAD:' + str(head_ref) + '\n\n'
        'CRITICAL RULES:\n'
        '- ONLY modify the files listed above\n'
        '- Do NOT change program logic or add features\n'
        '- Resolve merge conflicts carefully - keep BOTH sides where needed\n'
        '- You are mytheclipsebotreview - git identity already set\n'
        '- Use EXACTLY "fix: auto-fix code quality [skip ci]" as commit message'
    )
    
    BUFFER.append("   🤖 Running Claude Code AI fix (" + str(AI_FIX_MAX_TURNS) + " turns max)...")

    # Write prompt to file so user can see what Claude was asked.
    # Leftover root-owned copies from the pre-switchover era cause
    # PermissionError for the code user — write into our own workdir
    # (we already own it) instead of shared /tmp.
    log_path = workdir / ("claude_pr_" + str(pr_num) + ".prompt.txt")
    log_path.write_text(prompt)

    try:
        # Re-resolve CLAUDE_BIN at invocation time so a freshly installed
        # Claude Code is picked up without restarting the worker.
        claude_bin = shutil.which("claude") or CLAUDE_BIN
        if not os.path.isfile(claude_bin):
            subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
            return False, "[INFRA] Claude Code CLI not found at " + str(claude_bin)
        # If ~/.claude/settings.json already carries ANTHROPIC_BASE_URL/KEY,
        # Claude Code picks them up itself; use the CLI's own config and let
        # the injected env only fill what settings.json does not supply.
        env = {k: v for k, v in _claude_env().items() if k in (
            "PATH", "HOME", "HERMES_HOME",
            "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_URL",
        )}
        # Run with real-time output to file
        log_out = workdir / ("claude_pr_" + str(pr_num) + ".out.log")
        with open(log_out, "w") as lf:
            result = subprocess.run(
                [claude_bin, "-p", prompt,
                 "--allowedTools", "Read,Edit,Bash,Write",
                 "--max-turns", str(AI_FIX_MAX_TURNS)],
                cwd=str(workdir),
                stdout=lf,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
                timeout=AI_FIX_TIMEOUT
            )
        # Read back for analysis
        saved = log_out.read_text()
        claude_output = saved[-3000:] if len(saved) > 3000 else saved
    except subprocess.TimeoutExpired:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "[INFRA] Claude Code timed out"
    except FileNotFoundError:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "[INFRA] Claude Code CLI not found"

    # Check if Claude made changes
    push_success = False
    fix_count = 0
    push_exit = result.returncode
    if push_exit != 0:
        BUFFER.append("   ⚠️ Claude Code exited with code " + str(push_exit))
    
    if "git push" in claude_output.lower() or "pushed" in claude_output.lower() or "push" in claude_output.lower():
        push_success = True
    
    r3 = subprocess.run(
        ["git", "rev-list", "--count", str(head_sha[:12]) + "..HEAD"],
        capture_output=True, text=True, timeout=10, cwd=str(workdir)
    )
    try:
        new_commits = int(r3.stdout.strip())
        if new_commits > 0:
            push_success = True
            fix_count = new_commits
    except (ValueError, IndexError):
        pass
    
    # Clean up workdir + PID tracking file
    subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
    pid_file = TRACKING_DIR / (str(repo_full).replace("/", "_") + "_" + str(pr_num) + ".pid")
    pid_file.unlink(missing_ok=True)
    
    if push_success:
        return True, "Claude Code pushed " + str(fix_count) + " improvement commit(s)"
    else:
        snippet = claude_output[:300].replace("\n", " ")
        return False, "Claude ran but no push. Output: " + snippet

# ══════════════════════════════════════════════════════════════════════════
# Upstream Fork Auto-Sync (2026-09-21)
# ══════════════════════════════════════════════════════════════════════════
# For every repo the GitHub App is installed on whose metadata says `fork: true`,
# pull the commits the upstream (parent) repo has that the fork lacks and MERGE
# them into the fork's default branch — MERGE, never rebase, so the fork keeps
# its local divergence intact (skill: fork-upstream-sync).
#
# Why it lives in this worker: the worker already holds the atomic cron lock, has
# installation-token + Discord plumbing and runs every 5 minutes. The sync itself
# is gated by a per-repo interval (default 1h — user decision 2026-09-21).
#
# GitHub facts this code depends on (probed live 2026-09-21, see findings):
#   • /repos/{fork}/compare/{local}...{parent}:{upstream}
#       ahead_by  = upstream commits MISSING from the fork  → what we merge
#       behind_by = fork-only commits (divergence)          → never discarded
#     Verified against `git rev-list --count` on a real clone.
#   • The App has contents:write but NOT workflows:write. A merge that touches
#     .github/workflows/* can therefore only be pushed with the owner PAT
#     (gh CLI token, _fetch_gh_token()). Clones still use the App token.
#   • App tokens get 403 (not 404) on the branch-protection endpoint, so a
#     protected branch is detected from the PUSH result and falls back to a PR.
SYNC_STATE_FILE = Path("/tmp/pr-queue-sync-state.json")
SYNC_TMP_BASE = Path("/tmp/pr-queue-sync-work")
SYNC_PR_PREFIX = "upstream-sync-"
SYNC_CLAUDE_TIMEOUT = 900  # seconds: conflict resolution + verification run
UPSTREAM_SYNC = {
    "enabled": os.environ.get("PR_AGENT_UPSTREAM_SYNC", "1") != "0",
    "interval_h": 1.0,            # check upstream hourly (user decision 2026-09-21)
    "max_per_tick": 2,            # bound work per 5-minute tick
    "resolve_conflicts": True,    # hand a conflicted merge to Claude Code
    "ai_fix_after_merge": True,   # Claude Code quality pass on a clean merge
    "verify_ci": True,            # revert our own merge commit if the fork CI fails
    "verify_ci_max_age_h": 6.0,   # stop watching (keep the merge) after this
    "no_ci_grace_s": 600,         # wait this long before concluding "no CI here"
    "repos": {},                  # per-repo overrides, e.g.
                                  # {"owner/fork": {"interval_h": 6, "verify_ci": False,
                                  #                 "branches": {"local": "main", "upstream": "main"}}}
}


def load_sync_state():
    """Sync bookkeeping per fork: {repo_full: {last_sync_ts, last_attempt_sha,
    last_merged_upstream_sha, skip_reason, notified, pending_verify}}."""
    if SYNC_STATE_FILE.exists():
        try:
            return json.loads(SYNC_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_sync_state(state):
    try:
        SYNC_STATE_FILE.write_text(json.dumps(state, indent=1))
    except OSError:
        pass


def _sync_entry(state, repo_full):
    return state.setdefault(repo_full, {})


def sync_config(repo_full):
    """Worker-wide sync defaults merged with the per-repo override."""
    cfg = {k: v for k, v in UPSTREAM_SYNC.items() if k != "repos"}
    cfg.update(UPSTREAM_SYNC["repos"].get(repo_full) or {})
    return cfg


def post_sync_discord(title, lines, color=0x5865F2):
    """Post a fork-sync embed to the pr-agent-ops webhook (same channel as the
    run reports). Best-effort: never raises, never blocks a tick."""
    try:
        cfg = json.loads((pathlib.Path.home() / ".hermes/.ops-webhooks.json").read_text())
        url = cfg.get("pr-agent-ops")
        if not url:
            return False
        import httpx
        with httpx.Client(timeout=15) as client:
            r = client.post(url, json={
                "username": "PR-Agent Ops",
                "embeds": [{"title": title, "description": "\n".join(lines)[:4000], "color": color}],
            })
            return r.status_code in (200, 204)
    except Exception:
        return False


def _sync_git(args, cwd=None, timeout=180):
    """Run git, never raising: timeouts become exit 124, missing git exit 127."""
    cmd = ["git"] + [str(a) for a in args]
    try:
        return subprocess.run(
            cmd, cwd=str(cwd) if cwd else None,
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(cmd, 124, "", f"timeout after {timeout}s: {exc}")
    except FileNotFoundError:
        return subprocess.CompletedProcess(cmd, 127, "", "git not found")


def list_fork_repos():
    """[(app_token, fork_full_name, parent_full_name, default_branch)] for every
    fork in the App installation. The repo metadata lookup is per repo because
    the parent block is authoritative on the repo object."""
    out = []
    _, installs = gh_api("GET", "/app/installations")
    for inst in installs if isinstance(installs, list) else []:
        token = get_installation_token(inst["id"])
        if not token:
            continue
        _, repos = gh_api("GET", "/installation/repositories?per_page=100", token=token)
        for r in (repos.get("repositories", []) if isinstance(repos, dict) else []):
            full = r.get("full_name", "")
            if not full or not r.get("fork"):
                continue
            status, meta = gh_api("GET", f"/repos/{full}", token=token)
            parent = (meta.get("parent") or {}) if isinstance(meta, dict) else {}
            if status != 200 or not parent.get("full_name"):
                continue
            out.append((token, full, parent["full_name"], meta.get("default_branch") or "main"))
    return out


def upstream_status(token, fork, parent, local_branch, upstream_branch):
    """(merge_count, fork_divergence, upstream_tip_sha) for the fork branch vs the
    upstream branch, or None when the comparison is unavailable.

    merge_count = commits upstream has that the fork lacks (ahead_by on
    compare/{local}...{parent}:{upstream}) — i.e. what a sync would merge.

    NOTE the cross-repo compare syntax is `{owner}:{branch}` — passing the full
    `owner/repo` yields a 404 (verified live 2026-09-21), so only the owner part
    of the parent's full name goes into the head ref."""
    owner = parent.split("/")[0] if "/" in parent else parent
    path = f"/repos/{fork}/compare/{local_branch}...{owner}:{upstream_branch}"
    status, data = gh_api("GET", path, token=token)
    if status != 200:
        pat = _fetch_gh_token()
        if pat:
            status, data = gh_api("GET", path, token=pat)
    if status != 200 or not isinstance(data, dict):
        return None
    commits = data.get("commits") or []
    tip = commits[-1].get("sha", "") if commits else ""
    if not tip:
        s2, d2 = gh_api("GET", f"/repos/{parent}/commits/{upstream_branch}", token=token)
        if s2 == 200 and isinstance(d2, dict):
            tip = d2.get("sha", "")
    return int(data.get("ahead_by", 0)), int(data.get("behind_by", 0)), tip


def _sync_open_pr(token, fork, base_branch):
    """Number of an already-open upstream-sync PR targeting base_branch, else 0."""
    _, prs = gh_api("GET", f"/repos/{fork}/pulls?state=open&per_page=50", token=token)
    for pr in (prs if isinstance(prs, list) else []):
        head_ref = str((pr.get("head") or {}).get("ref", ""))
        if head_ref.startswith(SYNC_PR_PREFIX) and (pr.get("base") or {}).get("ref") == base_branch:
            return pr.get("number", 0)
    return 0


def _sync_push_urls(fork, app_token):
    """Push credentials, best first. The owner PAT comes first on purpose: the
    App lacks `workflows` permission, so a merge touching .github/workflows/*
    (very common when syncing) is rejected for the App token."""
    urls = []
    pat = _fetch_gh_token()
    if pat:
        urls.append((f"https://x-access-token:{pat}@github.com/{fork}.git", "pat"))
    if app_token:
        urls.append((f"https://x-access-token:{app_token}@github.com/{fork}.git", "app"))
    return urls


def _sync_fetch_url(parent):
    """Read credentials for the upstream fetch — the PAT when available (private
    upstreams + rate limits), plain HTTPS otherwise (public read needs no auth)."""
    pat = _fetch_gh_token()
    if pat:
        return f"https://x-access-token:{pat}@github.com/{parent}.git"
    return f"https://github.com/{parent}.git"


_PROTECTED_PUSH_MARKERS = (
    "protected branch",
    "gh006",
    "required status check",
    "branch protection",
    "protected_branch",
)
_WORKFLOW_PUSH_MARKERS = (
    "workflows permission",
    "workflows` permission",
    "create or update workflow",
)


def _is_protected_push_error(err):
    low = (err or "").lower()
    return any(m in low for m in _PROTECTED_PUSH_MARKERS)


def _is_workflow_push_error(err):
    low = (err or "").lower()
    return any(m in low for m in _WORKFLOW_PUSH_MARKERS)


def _push_ref(workdir, fork, source, dest, app_token, force=False):
    """Push `source` to `dest` on the fork. Returns (ok, detail, protected)."""
    refspec = ("+" if force else "") + f"{source}:{dest}"
    last = "no push credentials available"
    for url, kind in _sync_push_urls(fork, app_token):
        r = _sync_git(["push", url, refspec], workdir, 300)
        if r.returncode == 0:
            return True, f"{kind} push ok", False
        err = ((r.stderr or "") + (r.stdout or "")).strip()
        last = f"{kind}: {err[-260:]}"
        if _is_protected_push_error(err):
            return False, last, True
        if _is_workflow_push_error(err):
            # PAT missing/insufficient: the App cannot push workflow changes.
            return False, f"needs the `workflows` App permission or the gh PAT ({last})", False
    return False, last, False


def _run_claude_sync(workdir, prompt, label, fork, dry=False):
    """Run Claude Code inside the sync workdir. Returns (ok, snippet).

    Mirrors run_ai_fix's invocation (same binary resolution + provider env) but
    with its own log names, a longer timeout (conflict resolution runs a full
    test suite) and no push expectations — the harness pushes. Never spawns MCP
    servers (--mcp-config ''), which have been observed hanging this worker.

    In `dry` mode Claude is still run — the whole point of --dry is to exercise
    the real conflict resolution without pushing — but every side effect
    (Discord, state file, workdir cleanup) is skipped."""
    claude_bin = shutil.which("claude") or CLAUDE_BIN
    if not os.path.isfile(claude_bin):
        return False, "[INFRA] Claude Code CLI not found at " + str(claude_bin)
    if not dry:
        try:
            (workdir / (label + ".prompt.txt")).write_text(prompt)
        except OSError:
            pass
    env = {k: v for k, v in _claude_env().items() if k in (
        "PATH", "HOME", "HERMES_HOME",
        "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_URL",
    )}
    # Claude Code can hang for many minutes inside this worker when it spawns an
    # MCP server that stalls (observed 2026-09-21: `ouroboros mcp serve` under
    # uvx hung with zero output for 15+ minutes → the 900s timeout fired).
    # --mcp-config '' alone does NOT stop it — `claude -p` still starts MCP
    # servers from settings.json / managed / plugins. --strict-mcp-config
    # ignores ALL other MCP configuration and confines file tools to the
    # workdir. These calls only read/edit files in a throwaway clone and run
    # git — no MCP server is ever needed.
    mcp_args = ["--mcp-config", "", "--strict-mcp-config"]
    out_path = workdir / (label + ".out.log")
    try:
        with open(out_path, "w") as lf:
            res = subprocess.run(
                [claude_bin, "-p", prompt,
                 "--allowedTools", "Read,Edit,Bash,Write",
                 "--max-turns", str(AI_FIX_MAX_TURNS)] + mcp_args,
                cwd=str(workdir), stdout=lf, stderr=subprocess.STDOUT,
                text=True, env=env, timeout=SYNC_CLAUDE_TIMEOUT,
            )
        saved = out_path.read_text() if out_path.exists() else ""
    except subprocess.TimeoutExpired:
        return False, f"[INFRA] Claude Code timed out after {SYNC_CLAUDE_TIMEOUT}s"
    except FileNotFoundError:
        return False, "[INFRA] Claude Code CLI not found"
    except OSError as exc:
        return False, f"[INFRA] Claude Code could not run: {exc}"
    snippet = saved[-400:].replace("\n", " ") if saved else ""
    if res.returncode != 0:
        return False, f"claude exited {res.returncode}: {snippet}"
    return True, snippet


def _sync_unmerged_files(workdir):
    r = _sync_git(["diff", "--name-only", "--diff-filter=U"], workdir, 60)
    return [f for f in (r.stdout or "").split("\n") if f.strip()]


def _sync_finish_merge(workdir):
    """Complete an in-progress merge once every conflict is resolved."""
    unmerged = _sync_unmerged_files(workdir)
    if unmerged:
        return False, f"{len(unmerged)} file(s) still unmerged: {', '.join(unmerged[:5])}"
    _sync_git(["add", "-A"], workdir, 120)
    r = _sync_git(["commit", "--no-edit"], workdir, 120)
    if r.returncode != 0:
        combined = ((r.stdout or "") + (r.stderr or "")).lower()
        if "nothing to commit" in combined:
            return True, ""
        return False, ((r.stderr or r.stdout) or "").strip()[:200]
    return True, ""


def _sync_commit_if_dirty(workdir, message):
    """Commit pending edits made by a quality pass. Returns True if a commit was
    created (Claude normally commits itself; this is the safety net)."""
    st = _sync_git(["status", "--porcelain"], workdir, 60)
    if not (st.stdout or "").strip():
        return False
    _sync_git(["add", "-A"], workdir, 120)
    _sync_git(["commit", "--message", message], workdir, 120)
    return True


def _conflict_prompt(fork, parent, upstream_branch, local_branch, conflicted):
    """Prompt for resolving the halted upstream→fork merge.

    Encodes the fork-upstream-sync rules (merge both sides by hand, never
    wholesale --ours/--theirs, strip BOM, verify before committing) plus the
    merge-reconciler impartiality contract (classify each hunk, no drive-by
    edits, report every decision)."""
    files = "\n".join("  - " + f for f in conflicted[:40])
    more = "" if len(conflicted) <= 40 else f"\n  ... and {len(conflicted) - 40} more"
    return (
        "A `git merge` is IN PROGRESS inside this repository and stopped with conflicts.\n"
        f"Direction: {parent} (branch {upstream_branch}) → {fork} (branch {local_branch}).\n"
        "You are the neutral reconciler: neither side may be dropped.\n\n"
        f"Conflicted files:\n{files}{more}\n\n"
        "TASK: resolve every conflict, then finish the merge.\n\n"
        "CLASSIFY EVERY HUNK before editing, then resolve by class:\n"
        "  • disjoint-intent — the two changes serve different goals → keep BOTH.\n"
        "  • same-question-different-answer — both sides answered one question\n"
        "    differently → pick the one matching the fork's stated intent and note\n"
        "    the decision; never invent a hybrid nobody asked for.\n"
        "  • superseded — one side's premise no longer holds after the other change\n"
        "    → keep the surviving side and record why.\n\n"
        "RULES (non-negotiable):\n"
        "1. Merge conflicting hunks by hand. NEVER `git checkout --ours/--theirs`\n"
        "   wholesale, never `git rebase`, never delete a side without saying why.\n"
        "2. The fork carries local features upstream does not know about: every\n"
        "   fork-only feature must still work after the merge.\n"
        "3. Change NOTHING outside conflict markers — no reformatting, no renames,\n"
        "   no opportunistic fixes.\n"
        "4. If a file starts with a UTF-8 BOM (bytes EF BB BF), strip it.\n"
        "5. VERIFY before committing: run the repository's own checks when they\n"
        "   exist (package.json scripts: `bun run typecheck`, `bun test`; else\n"
        "   `npm test`, `cargo test`, `pytest -q`). Fix what YOUR resolution broke\n"
        "   until they pass.\n"
        "6. Complete the merge: `git add -A && git commit --no-edit`\n"
        "7. Do NOT push — the harness pushes after you finish.\n\n"
        "Finish with a report listing, per file, the hunks you resolved and which\n"
        "side(s) you kept, the verification commands you ran, and their results."
    )


def _quality_prompt(fork, parent, upstream_branch, files):
    file_list = "\n".join("  - " + f for f in files[:30])
    if len(files) > 30:
        file_list += f"\n  ... and {len(files) - 30} more"
    return (
        f"The fork {fork} just merged {parent} (branch {upstream_branch}) into its\n"
        "default branch. The merge itself is already committed and correct.\n\n"
        f"Files the merge changed:\n{file_list}\n\n"
        "TASK: improve code quality of ONLY these files — naming, DRY, error\n"
        "handling, missing types, docstrings, clear anti-patterns.\n\n"
        "RULES:\n"
        "- Behavior must stay identical. Do NOT add features or change logic.\n"
        "- Do NOT rewrite the upstream architecture; this is a fresh merge.\n"
        "- Run the repository's checks when they exist (`bun run typecheck`,\n"
        "  `bun test`, else `npm test`/`cargo test`/`pytest -q`) and keep them green.\n"
        "- Commit exactly one commit: `git add -A && git commit --message=\"fix: auto-fix code quality [skip ci]\"`\n"
        "- Do NOT push — the harness pushes after you finish."
    )


def _sync_revert_merge(app_token, fork, branch, pre_merge_sha, reason):
    """Force the fork branch back to the pre-merge commit. Only ever called when
    the branch tip IS our own merge commit (sha-guarded by the caller)."""
    workdir = SYNC_TMP_BASE / (fork.replace("/", "_") + "_revert")
    if workdir.exists():
        subprocess.run(["rm", "-rf", str(workdir)], timeout=60)
    workdir.parent.mkdir(parents=True, exist_ok=True)
    clone_url = f"https://x-access-token:{app_token}@github.com/{fork}.git" if app_token else f"https://github.com/{fork}.git"
    r = _sync_git(["clone", clone_url, str(workdir), "--branch", branch], None, 300)
    if r.returncode != 0:
        return False, f"revert clone failed: {(r.stderr or '').strip()[:160]}"
    try:
        have = _sync_git(["cat-file", "-e", pre_merge_sha + "^{commit}"], workdir, 60)
        if have.returncode != 0:
            return False, f"pre-merge commit {pre_merge_sha[:8]} not found in clone"
        ok, detail, _protected = _push_ref(
            workdir, fork, pre_merge_sha, f"refs/heads/{branch}", app_token, force=True)
        if ok:
            return True, f"reverted {branch} to {pre_merge_sha[:8]} ({reason})"
        return False, f"revert push failed: {detail[:200]}"
    finally:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=60)


def verify_pending_syncs(state, token_by_repo, dry=False):
    """CI-verify merges we pushed directly. A failed fork CI at OUR merge commit
    (while it is still the tip) reverts the merge instead of leaving a red main.
    Returns report lines."""
    lines = []
    for fork in list(state.keys()):
        entry = state.get(fork) or {}
        pending = entry.get("pending_verify") or {}
        if not pending.get("sha"):
            continue
        token = token_by_repo.get(fork, "")
        if not token:
            continue
        cfg = sync_config(fork)
        branch = pending.get("branch") or "main"
        if not cfg.get("verify_ci", True) or dry:
            entry["pending_verify"] = None
            continue
        age = time.time() - float(pending.get("pushed_at") or 0)
        if age > cfg["verify_ci_max_age_h"] * 3600:
            lines.append(f"   ⌛ {fork}: merge {pending['sha'][:8]} unverified for "
                         f"{age / 3600:.1f}h — keeping it, stopping the watch")
            entry["pending_verify"] = None
            save_sync_state(state)
            continue
        s, data = gh_api("GET", f"/repos/{fork}/commits/{branch}?per_page=1", token=token)
        tip = data[0]["sha"] if isinstance(data, list) and data else ""
        if tip and tip != pending["sha"]:
            lines.append(f"   ✓ {fork}: {branch} moved past our merge "
                         f"({pending['sha'][:8]} → {tip[:8]}) — nothing to verify")
            entry["pending_verify"] = None
            save_sync_state(state)
            continue
        s, data = gh_api("GET", f"/repos/{fork}/commits/{pending['sha']}/check-runs", token=token)
        checks = data.get("check_runs", []) if isinstance(data, dict) else []
        failed = [c for c in checks if c.get("conclusion") == "failure"]
        running = [c for c in checks if c.get("status") != "completed"]
        if failed:
            names = ", ".join(c.get("name", "?") for c in failed[:3])
            ok, detail = _sync_revert_merge(token, fork, branch, pending.get("pre_merge_sha", ""), f"CI failed: {names}")
            lines.append(f"   ↩️  {fork}: {detail}")
            post_sync_discord(
                f"↩️ Fork sync reverted: {fork}",
                [f"CI failed at our merge commit `{pending['sha'][:8]}` ({names}).",
                 detail,
                 f"https://github.com/{fork}/commits/{branch}"],
                0xE74C3C,
            )
            entry["pending_verify"] = None
            entry["last_merged_upstream_sha"] = ""
            save_sync_state(state)
            continue
        if not checks:
            if age < cfg["no_ci_grace_s"]:
                continue  # check-runs may not have registered yet
            entry["pending_verify"] = None
            save_sync_state(state)
            continue
        if running:
            continue  # still running — verify on a later tick
        lines.append(f"   ✅ {fork}: merge {pending['sha'][:8]} verified green "
                     f"({len(checks)} check(s))")
        entry["pending_verify"] = None
        save_sync_state(state)
    return lines


def sync_fork_repo(token, fork, parent, local_branch, upstream_branch, upstream_sha,
                   merge_count, divergence, state, cfg, dry=False):
    """One sync attempt for one fork: clone → merge upstream → Claude Code when
    needed → push (or open a PR when the branch is protected). Returns
    (status, detail) with status ∈ synced|pr-opened|conflict-failed|push-failed|error|dry|pr-path.

    `dry` mode runs every step except the ones with remote side effects — no
    push, no PR, no state mutation, no Discord — because the caller creates
    `state` fresh and passes it in (a dry run must leave nothing behind)."""
    entry = _sync_entry(state, fork) if not dry else {}
    workdir = SYNC_TMP_BASE / fork.replace("/", "_")
    try:
        if dry:
            entry = {}  # keep the state passed in untouched during a dry run
        if workdir.exists():
            subprocess.run(["rm", "-rf", str(workdir)], timeout=60)
        workdir.parent.mkdir(parents=True, exist_ok=True)
        clone_url = f"https://x-access-token:{token}@github.com/{fork}.git"
        r = _sync_git(["clone", clone_url, str(workdir), "--branch", local_branch], None, 300)
        if r.returncode != 0:
            entry["last_sync_ts"] = time.time()
            save_sync_state(state)
            return "error", f"clone failed: {(r.stderr or '').strip()[:200]}"
        _sync_git(["config", "user.name", "mytheclipsebotreview"], workdir, 30)
        _sync_git(["config", "user.email", "bot@users.noreply.github.com"], workdir, 30)
        pre_merge_sha = (_sync_git(["rev-parse", "HEAD"], workdir, 30).stdout or "").strip()

        upstream_ref = f"refs/remotes/upstream/{upstream_branch}"
        r = _sync_git(["fetch", "--no-tags", _sync_fetch_url(parent),
                       f"{upstream_branch}:{upstream_ref}"], workdir, 300)
        if r.returncode != 0:
            entry["last_sync_ts"] = time.time()
            save_sync_state(state)
            return "error", f"upstream fetch failed: {(r.stderr or '').strip()[:200]}"

        r = _sync_git(["merge", upstream_ref, "--no-edit"], workdir, 300)
        conflicted = _sync_unmerged_files(workdir)
        if r.returncode != 0 and not conflicted:
            entry["last_sync_ts"] = time.time()
            save_sync_state(state)
            return "error", f"merge error: {((r.stderr or '') + (r.stdout or '')).strip()[:200]}"

        if conflicted:
            if not cfg.get("resolve_conflicts", True):
                _sync_git(["merge", "--abort"], workdir, 60)
                note = (f"{len(conflicted)} conflicting file(s) and conflict resolution is "
                        f"disabled: {', '.join(conflicted[:5])}")
                if not dry:
                    entry.update({"last_sync_ts": time.time(), "last_attempt_sha": upstream_sha,
                                  "skip_reason": note, "notified": False})
                    save_sync_state(state)
                return "conflict-failed", note
            BUFFER.append(f"      🤖 resolving {len(conflicted)} conflict(s) with Claude Code "
                          f"(up to {SYNC_CLAUDE_TIMEOUT}s)...")
            ok, snippet = _run_claude_sync(
                workdir, _conflict_prompt(fork, parent, upstream_branch, local_branch, conflicted),
                "claude_sync_conflicts", fork, dry)
            if not ok:
                _sync_git(["merge", "--abort"], workdir, 60)
                note = f"conflict resolution failed — {snippet[:200]}"
                if not dry:
                    entry.update({"last_sync_ts": time.time(), "last_attempt_sha": upstream_sha,
                                  "skip_reason": note, "notified": False})
                    save_sync_state(state)
                return "conflict-failed", note
            done, why = _sync_finish_merge(workdir)
            if not done:
                _sync_git(["merge", "--abort"], workdir, 60)
                note = f"conflict resolution incomplete — {why}"
                if not dry:
                    entry.update({"last_sync_ts": time.time(), "last_attempt_sha": upstream_sha,
                                  "skip_reason": note, "notified": False})
                    save_sync_state(state)
                return "conflict-failed", note
            resolution = f"Claude Code resolved {len(conflicted)} conflict(s)"
        else:
            resolution = "clean merge"
            if cfg.get("ai_fix_after_merge", True):
                diff = _sync_git(["diff", "--name-only", f"{pre_merge_sha}..HEAD"], workdir, 120)
                merged_files = [f for f in (diff.stdout or "").split("\n") if f.strip()]
                if merged_files:
                    BUFFER.append(f"      🤖 Claude Code quality pass on {len(merged_files)} merged file(s)...")
                    ok, snippet = _run_claude_sync(
                        workdir, _quality_prompt(fork, parent, upstream_branch, merged_files),
                        "claude_sync_quality", fork, dry)
                    if ok:
                        if _sync_commit_if_dirty(workdir, "fix: auto-fix code quality [skip ci]"):
                            resolution += " + Claude Code quality pass committed"
                        else:
                            resolution += " + quality pass made no changes"
                    else:
                        resolution += f" (quality pass skipped: {snippet[:120]})"

        still_unmerged = _sync_unmerged_files(workdir)
        if still_unmerged:
            note = f"unmerged paths remain: {', '.join(still_unmerged[:5])}"
            if not dry:
                entry.update({"last_sync_ts": time.time(), "last_attempt_sha": upstream_sha,
                              "skip_reason": note, "notified": False})
                save_sync_state(state)
            return "conflict-failed", note

        merged_sha = (_sync_git(["rev-parse", "HEAD"], workdir, 30).stdout or "").strip()
        if dry:
            return "dry", (f"prepared in {workdir} — pre_merge {pre_merge_sha[:8]}, "
                           f"upstream {upstream_sha[:8]}, head {merged_sha[:8]}, {resolution}")

        ok, detail, protected = _push_ref(
            workdir, fork, "HEAD", f"refs/heads/{local_branch}", token)
        if ok:
            entry.update({
                "last_sync_ts": time.time(),
                "last_attempt_sha": upstream_sha,
                "last_merged_upstream_sha": upstream_sha,
                "skip_reason": "",
                "notified": False,
                "pending_verify": {
                    "sha": merged_sha, "pre_merge_sha": pre_merge_sha,
                    "branch": local_branch, "pushed_at": time.time(),
                },
            })
            save_sync_state(state)
            return "synced", (f"{merge_count} upstream commit(s) merged into {local_branch} "
                              f"({resolution}); head {merged_sha[:8]}; {detail}")

        if protected:
            if dry:
                return "pr-path", (f"protected branch detected ({detail[:120]}) — "
                                   f"would open an upstream-sync PR")
            pr_num = open_sync_pr(token, workdir, fork, parent, local_branch, upstream_branch,
                                  upstream_sha, merge_count, divergence, resolution)
            if pr_num:
                entry.update({
                    "last_sync_ts": time.time(),
                    "last_attempt_sha": upstream_sha,
                    "last_merged_upstream_sha": "",
                    "skip_reason": "",
                    "notified": False,
                })
                save_sync_state(state)
                return "pr-opened", (f"{local_branch} is protected — opened PR #{pr_num} "
                                     f"({merge_count} upstream commit(s), {resolution})")
            entry["last_sync_ts"] = time.time()
            save_sync_state(state)
            return "push-failed", f"protected branch and PR creation failed: {detail[:200]}"

        entry["last_sync_ts"] = time.time()
        entry["last_attempt_sha"] = upstream_sha
        entry["skip_reason"] = detail[:200]
        entry["notified"] = False
        save_sync_state(state)
        return "push-failed", detail[:300]
    except Exception as exc:  # a sync must never take the whole tick down
        return "error", f"{type(exc).__name__}: {exc}"
    finally:
        if not dry:
            subprocess.run(["rm", "-rf", str(workdir)], timeout=60)


def open_sync_pr(token, workdir, fork, parent, base_branch, upstream_branch,
                 upstream_sha, merge_count, divergence, resolution):
    """Push the merged workdir as a `upstream-sync-<ts>` branch and open a PR
    against base_branch. The normal worker pipeline (review → CI → approve →
    merge) finishes the job. Returns the PR number, or 0 on failure."""
    sync_branch = SYNC_PR_PREFIX + time.strftime("%Y%m%d-%H%M%S")
    r = _sync_git(["checkout", "-b", sync_branch], workdir, 60)
    if r.returncode != 0:
        return 0
    ok, _detail, _protected = _push_ref(workdir, fork, "HEAD", f"refs/heads/{sync_branch}", token)
    if not ok:
        return 0
    body = (
        f"⬆️ Automated upstream sync from `{parent}` (branch `{upstream_branch}`).\n\n"
        f"- upstream commits merged: **{merge_count}**\n"
        f"- fork-only commits preserved: **{divergence}**\n"
        f"- upstream tip: `{upstream_sha}`\n"
        f"- merge: {resolution}\n\n"
        f"Opened by pr-queue-worker because `{base_branch}` is a protected branch, so the\n"
        "merge goes through the normal pipeline (PR-Agent review → AI fix → CI → approve → merge).\n\n"
        f"Compare: https://github.com/{fork}/compare/{base_branch}...{parent}:{upstream_branch}"
    )
    status, data = gh_api("POST", f"/repos/{fork}/pulls", token=token, json_data={
        "title": f"⬆️ upstream-sync: merge {parent}@{upstream_sha[:8]} into {base_branch}",
        "head": sync_branch,
        "base": base_branch,
        "body": body,
    })
    if status in (200, 201) and isinstance(data, dict):
        return data.get("number", 0)
    return 0


def run_upstream_sync(only=None, dry=False):
    """Sync every fork in the installation (bounded per tick), verify merges we
    pushed earlier, and return the report lines. Never raises.

    In `dry` mode: no state file writes, no Discord posts, no pushes, no PRs —
    the compare flow runs against a throwaway in-memory state (so the gating
    `_sync_entry` calls stay off the real /tmp state file) and reports what
    WOULD happen."""
    lines = []
    if not UPSTREAM_SYNC["enabled"] and not only:
        return lines
    try:
        state = load_sync_state()
        if dry:
            state = {}  # never touch the real state during a dry run
        forks = list_fork_repos()
        if only:
            forks = [f for f in forks if f[1] == only]
        token_by_repo = {f[1]: f[0] for f in forks}
        lines += verify_pending_syncs(state, token_by_repo, dry)

        now = time.time()
        # oldest attempt first so the per-tick budget rotates fairly across forks
        forks.sort(key=lambda f: _sync_entry(state, f[1]).get("last_sync_ts") or 0)
        budget = int(UPSTREAM_SYNC["max_per_tick"])
        for token, fork, parent, branch in forks:
            cfg = sync_config(fork)
            if not cfg.get("enabled", True):
                continue
            if budget <= 0 and not only:
                break
            branches = cfg.get("branches") or {}
            s, meta = gh_api("GET", f"/repos/{fork}", token=token)
            parent_meta = (meta.get("parent") or {}) if isinstance(meta, dict) else {}
            local_branch = branches.get("local") or branch
            upstream_branch = (branches.get("upstream")
                               or parent_meta.get("default_branch") or local_branch)
            info = upstream_status(token, fork, parent, local_branch, upstream_branch)
            if info is None:
                lines.append(f"🔁 {fork}: upstream comparison unavailable — will retry")
                continue
            merge_count, divergence, upstream_sha = info
            entry = _sync_entry(state, fork)
            if merge_count <= 0:
                if entry.get("skip_reason"):
                    entry["skip_reason"] = ""
                    save_sync_state(state)
                continue  # in sync — silent
            if entry.get("last_attempt_sha") == upstream_sha:
                continue  # this upstream tip was already handled (synced/skipped)
            if now - float(entry.get("last_sync_ts") or 0) < cfg["interval_h"] * 3600:
                continue  # interval not due yet — silent
            open_pr = _sync_open_pr(token, fork, local_branch)
            if open_pr:
                lines.append(f"🔁 {fork}: upstream-sync PR #{open_pr} already open — waiting")
                continue
            lines.append(f"🔁 {fork}: `{parent}` has {merge_count} commit(s) the fork lacks "
                         f"(fork divergence {divergence}) — syncing into {local_branch}...")
            res, detail = sync_fork_repo(
                token, fork, parent, local_branch, upstream_branch, upstream_sha,
                merge_count, divergence, state, cfg, dry)
            entry = _sync_entry(state, fork)
            if res == "synced":
                merged_sha = (entry.get("pending_verify") or {}).get("sha", "")[:8]
                lines.append(f"   ✅ merged + pushed: {detail}")
                if not dry:
                    post_sync_discord(
                        f"🔁 Fork synced: {fork}",
                        [f"⬆️ {merge_count} upstream commit(s) from `{parent}` merged into `{local_branch}`.",
                         f"merge head `{merged_sha}` (CI-verified on the next ticks; reverted automatically if red).",
                         f"https://github.com/{fork}"],
                    )
                budget -= 1
            elif res == "pr-opened":
                lines.append(f"   📬 {detail}")
                if not dry:
                    post_sync_discord(
                        f"📬 Fork sync PR opened: {fork}",
                        [detail, f"https://github.com/{fork}/pulls"],
                    )
                budget -= 1
            elif res == "dry":
                lines.append(f"   🧪 dry run: {detail}")
                budget -= 1
            elif res == "pr-path":
                lines.append(f"   🧪 dry run (protected): {detail}")
                budget -= 1
            elif res == "conflict-failed":
                lines.append(f"   ⏭️  {detail}")
                if not dry and not entry.get("notified"):
                    entry["notified"] = True
                    save_sync_state(state)
                    post_sync_discord(
                        f"⏭️ Fork sync skipped: {fork}",
                        [f"❗ {detail}",
                         f"upstream `{parent}@{upstream_sha[:8]}` — retried when upstream moves or the state file is cleared.",
                         f"https://github.com/{fork}"],
                        0xE67E22,
                    )
                budget -= 1
            else:
                lines.append(f"   ⚠️  {res}: {detail}")
                budget -= 1
        save_sync_state(state)
    except Exception as exc:
        lines.append(f"⚠️  Upstream sync error: {type(exc).__name__}: {exc}")
    return lines


# ── Main ──
def main():
    start = time.time()
    global BUFFER

    if not get_lock():
        return

    try:
        # ── STEP 0: Upstream fork auto-sync (hourly per fork, bounded per tick) ──
        # Runs before the PR loop so a fork's default branch is refreshed while
        # the same tick still processes PRs. Never raises (returns report lines).
        sync_lines = run_upstream_sync()

        all_prs = gather_open_prs()
        if not all_prs and not sync_lines:
            return  # truly silent

        BUFFER.append(f"🔍 PR Queue Worker — {time.ctime()}")
        BUFFER.append(f"{'='*50}")
        if sync_lines:
            BUFFER.extend(sync_lines)
        if all_prs:
            BUFFER.append(f"📋 Found {len(all_prs)} open PR(s) to process")
            if AI_FIX_ENABLED:
                BUFFER.append(f"   ✨ AI auto-fix: ENABLED (Claude Code)")

        merged_count = 0
        triggered_count = 0
        fixed_count = 0
        skipped_count = 0

        for token, repo_full, pr in all_prs:
            pr_num = pr["number"]
            title = pr.get("title", "untitled")[:60]
            head_sha = pr.get("head", {}).get("sha", "")
            head_ref = pr.get("head", {}).get("ref", "")
            base_ref = pr.get("base", {}).get("ref", "")
            author = pr.get("user", {}).get("login", "")
            mergeable = pr.get("mergeable")

            BUFFER.append(f"\n{'─'*40}")
            BUFFER.append(f"🔀 {repo_full} #{pr_num} — {title}")
            BUFFER.append(f"   👤 {author} | branch: {head_ref} → {base_ref}")

            if pr.get("merged") or pr.get("state") != "open":
                BUFFER.append(f"   ⏭️  Already merged/closed")
                skipped_count += 1
                continue

            # ── STEP A0: Toolchain pin guard (2026-09-21) ──
            # Close dependabot PRs that bump pinned toolchain majors IMMEDIATELY,
            # before any review trigger / AI fix / CI wait burns tokens or time.
            if author == "dependabot[bot]":
                violation = toolchain_pin_violation(repo_full, title)
                if violation:
                    pkg, old_ver, new_ver = violation
                    BUFFER.append(
                        f"   ⛔ Toolchain pin violation: {pkg} {old_ver} → {new_ver} "
                        f"(allowed major {TOOLCHAIN_PINS[repo_full][pkg]})"
                    )
                    close_status, _ = close_toolchain_pr(token, repo_full, pr_num, pkg, old_ver, new_ver)
                    if close_status == 200:
                        BUFFER.append(f"   ✅ Closed #{pr_num} (pin violation)")
                        skipped_count += 1
                    else:
                        BUFFER.append(f"   ⚠️  Close failed HTTP {close_status} — leaving open")
                    continue  # never review / fix / merge a pin-violating PR

            # ── STEP A: Find or trigger review ──
            no_code_review = False
            review_body = find_review_comment(token, repo_full, pr_num)

            if not review_body:
                # Trivial PRs (dependabot lockfile-only) never get a "PR Reviewer
                # Guide" — PR-Agent reports "PR Code Suggestions: No code suggestions
                # found" because there is no code diff. That IS a clean bill of
                # health: reviewed, nothing to fix. Treat it as a review and let
                # the normal merge path (CI gate → approve → merge) proceed,
                # instead of re-triggering every cycle or skipping outright.
                if is_trivial_pr(title, author) and find_trivial_noreview_marker(token, repo_full, pr_num):
                    BUFFER.append(f"   📝 PR-Agent assessed (no-code/lockfile PR) — no code to review, treating as reviewed")
                    no_code_review = True
                    review_body = (
                        "## PR Reviewer Guide 🔍\n"
                        "⏱️ Estimated effort to review: 1 🔵⚪⚪⚪⚪\n"
                        "🏅 Score: 100\n"
                        "🔒 No security concerns identified\n"
                        "⚡ No major issues detected\n"
                        "🧪 No relevant tests\n"
                        "No code changes to review (dependency/lockfile-only bump)."
                    )
                else:
                    no_code_review = False
                    BUFFER.append(f"   📡 No review → triggering PR-Agent...")
                    result = trigger_pr_agent_review(repo_full, pr_num, title, head_sha, head_ref, base_ref)
                    if isinstance(result, int) and 200 <= result < 300:
                        BUFFER.append(f"   ✅ PR-Agent triggered (HTTP {result})")
                        triggered_count += 1
                    else:
                        BUFFER.append(f"   ⚠️  Trigger result: {result}")
                    # Skip AI fix and merge until next cycle (review needs to complete)
                    continue

            BUFFER.append(f"   📝 Review found")

            # Check if already fixed at this SHA (prevent duplicate Claude Code runs)
            fix_state = load_fix_state()
            already = already_fixed(fix_state, repo_full, pr_num, head_sha)

            # Permanent skip (infra error / conflict-unresolvable): don't re-run
            # every cron tick — respect the recorded reason until head changes.
            skip_reason = get_skip_reason(fix_state, repo_full, pr_num, head_sha)
            if skip_reason:
                BUFFER.append(f"   ⏭️  Permanently skipped: {skip_reason} (until head SHA changes)")
                notify_skip_once(fix_state, repo_full, pr_num, head_sha, skip_reason)
                skipped_count += 1
                continue

            # ── STEP B: REAL AI Auto-Fix (Claude Code) — ALL PRs (no skip) ──
            if AI_FIX_ENABLED and not no_code_review:
                # For trivial PRs (dependabot), first try lockfile fix to unblock CI.
                # mcpedia is a Bun monorepo → bun.lock (NOT uv.lock).
                # CI fails `bun install --frozen-lockfile` when lockfile is stale.
                if is_trivial_pr(title, author) and not already:
                    ci_ok_early, ci_msg_early = check_ci_passed(token, repo_full, head_sha)
                    if not ci_ok_early and "typecheck" in ci_msg_early:
                        has_bun = _repo_has_bun_lock(token, repo_full, head_sha)
                        if has_bun:
                            BUFFER.append("   🔧 CI failing: bun.lock stale — pre-fixing...")
                            lock_fixed, lock_summary = fix_bun_lock_for_trivial_pr(
                                repo_full, pr_num, title, head_sha, head_ref, base_ref, token
                            )
                            if lock_fixed:
                                BUFFER.append(f"   ✅ {lock_summary}")
                                _, fresh_pr = gh_api("GET", f"/repos/{repo_full}/pulls/{pr_num}", token=token)
                                if isinstance(fresh_pr, dict):
                                    new_sha = fresh_pr.get("head", {}).get("sha", "")
                                    if new_sha and new_sha != head_sha:
                                        BUFFER.append("   🔄 Head SHA updated")
                                        head_sha = new_sha
                        elif "uv.lock" not in ci_msg_early:
                            # Non-Bun repos: try uv.lock
                            BUFFER.append("   🔧 CI failing: uv.lock stale — pre-fixing...")
                            lock_fixed, lock_summary = fix_uv_lock_for_trivial_pr(
                                repo_full, pr_num, title, head_sha, head_ref, base_ref, token
                            )
                            if lock_fixed:
                                BUFFER.append(f"   ✅ {lock_summary}")
                                _, fresh_pr = gh_api("GET", f"/repos/{repo_full}/pulls/{pr_num}", token=token)
                                if isinstance(fresh_pr, dict):
                                    new_sha = fresh_pr.get("head", {}).get("sha", "")
                                    if new_sha and new_sha != head_sha:
                                        BUFFER.append("   🔄 Head SHA updated")
                                        head_sha = new_sha

                # Then run Claude Code AI fix on ALL PRs — no exceptions
                if already:
                    BUFFER.append(f"   ⏭️  Already fixed at this SHA — skip AI fix")
                else:
                    # Check PR still valid before running Claude
                    valid, new_sha, new_mergeable, reason = check_pr_still_valid(
                        token, repo_full, pr_num, head_sha
                    )
                    if not valid:
                        BUFFER.append(f"   ⏭️  PR changed: {reason}")
                        if new_sha:
                            head_sha = new_sha
                            mergeable = new_mergeable
                    else:
                        # Kill any orphaned Claude from previous run on this PR
                        kill_orphaned_claude(repo_full, pr_num)
                        fixed, summary = run_ai_fix(
                            repo_full, pr_num, title, head_sha, head_ref, base_ref, token
                        )
                        if fixed:
                            BUFFER.append(f"   ✨ {summary}")
                            fixed_count += 1
                            # Mark as fixed so we don't re-run next minute
                            mark_fixed(fix_state, repo_full, pr_num, head_sha)
                            # Re-fetch PR to get new head SHA after AI push
                            _, fresh_pr = gh_api("GET", f"/repos/{repo_full}/pulls/{pr_num}", token=token)
                            if isinstance(fresh_pr, dict):
                                new_sha = fresh_pr.get("head", {}).get("sha", "")
                                if new_sha and new_sha != head_sha:
                                    BUFFER.append(f"   🔄 Head SHA updated for merge")
                                    head_sha = new_sha
                                    mergeable = fresh_pr.get("mergeable")
                        else:
                            BUFFER.append(f"   ⏭️  AI fix skipped: {summary}")
                            if summary.startswith("[INFRA]"):
                                # Infra-level failure (CLI missing/timeout/unreachable):
                                # permanently skip this PR at this SHA — retrying every
                                # 5 min would just loop. Notify Discord once.
                                reason = summary.replace("[INFRA] ", "")
                                mark_skip(fix_state, repo_full, pr_num, head_sha, reason)
                                if notify_skip_once(fix_state, repo_full, pr_num, head_sha, reason):
                                    BUFFER.append(f"   🔔 Skip notified: {reason}")

            # ── STEP C: Safety analysis ──
            is_safe, reasons, score = analyze_review_safety(review_body)
            for r in reasons:
                BUFFER.append(f"   {r}")

            if not is_safe:
                BUFFER.append(f"   🔴 SAFETY BLOCKED (score: {score}/10)")
                skipped_count += 1
                continue

            BUFFER.append(f"   ✅ Safety score: {score}/10")

            # ── STEP D: CI check ──
            ci_ok, ci_msg = check_ci_passed(token, repo_full, head_sha)
            BUFFER.append(f"   🧪 CI: {ci_msg}")
            if not ci_ok:
                # Dependabot PR stuck failing CI for days → close (never will pass)
                if author == "dependabot[bot]":
                    try:
                        created = pr.get("created_at", "")
                        age_days = (time.time() - time.mktime(time.strptime(created, "%Y-%m-%dT%H:%M:%SZ"))) / 86400
                    except Exception:
                        age_days = 0
                    if age_days > STALE_CI_CLOSE_DAYS:
                        BUFFER.append(f"   ⛔ CI failing for {age_days:.1f}d — closing stale dependabot PR")
                        close_status, _ = close_stale_ci_pr(token, repo_full, pr_num, title, ci_msg)
                        if close_status == 200:
                            BUFFER.append(f"   ✅ Closed #{pr_num} (stale failing CI)")
                            skipped_count += 1
                            continue
                        BUFFER.append(f"   ⚠️  Close failed HTTP {close_status}")
                BUFFER.append(f"   ⏳ Waiting for green CI")
                skipped_count += 1
                continue

            if mergeable is False:
                BUFFER.append(f"   🔴 Merge conflicts")
                # Auto-resolve via Claude Code (its prompt already merges base
                # and resolves conflicts). One attempt per head SHA — if it
                # keeps conflicting, skip permanently instead of looping.
                if AI_FIX_ENABLED and not already:
                    valid, _new_sha, _new_mergeable, _reason = check_pr_still_valid(
                        token, repo_full, pr_num, head_sha
                    )
                    if valid:
                        BUFFER.append(f"   🤖 Resolving merge conflict with Claude Code...")
                        kill_orphaned_claude(repo_full, pr_num)
                        fixed, summary = run_ai_fix(
                            repo_full, pr_num, title, head_sha, head_ref, base_ref, token
                        )
                        if fixed:
                            BUFFER.append(f"   ✨ Conflict resolved: {summary}")
                            fixed_count += 1
                            mark_fixed(fix_state, repo_full, pr_num, head_sha)
                            # Re-fetch for new head SHA; next cron tick will re-check
                            # mergeable and merge if clean.
                            _, fresh_pr = gh_api("GET", f"/repos/{repo_full}/pulls/{pr_num}", token=token)
                            if isinstance(fresh_pr, dict):
                                new_sha = fresh_pr.get("head", {}).get("sha", "")
                                if new_sha and new_sha != head_sha:
                                    BUFFER.append(f"   🔄 Head SHA updated (conflict fix pushed)")
                            # Not merged this tick — leave for next cycle
                            skipped_count += 1
                            continue
                        else:
                            BUFFER.append(f"   ⏭️  Conflict fix failed: {summary}")
                            if summary.startswith("[INFRA]"):
                                reason = summary.replace("[INFRA] ", "")
                            else:
                                reason = "Unresolvable merge conflict (Claude Code made no push)"
                            mark_skip(fix_state, repo_full, pr_num, head_sha, reason)
                            if notify_skip_once(fix_state, repo_full, pr_num, head_sha, reason):
                                BUFFER.append(f"   🔔 Skip notified: {reason}")
                            skipped_count += 1
                            continue
                BUFFER.append(f"   ⏭️  Skipping (conflict, already attempted at this SHA)")
                skipped_count += 1
                continue

            # ── STEP E: Approve + Merge ──
            BUFFER.append(f"   👍 Approving...")
            approve_status = approve_pr(token, repo_full, pr_num)
            if approve_status not in (200, 201):
                BUFFER.append(f"   ⚠️  Approve: HTTP {approve_status}")
            else:
                BUFFER.append(f"   ✅ Approved!")

            BUFFER.append(f"   🔀 Merging...")
            merge_status, merge_data = merge_pr(token, repo_full, pr_num, head_sha)
            if merge_status == 200:
                BUFFER.append(f"   ✅ MERGED! SHA: {merge_data.get('sha', '?')}")
                merged_count += 1
                post_discord_notification(repo_full, pr_num, "done",
                                          summary=f"PR merged ({title})",
                                          score=score,
                                          url=f"https://github.com/{repo_full}/pull/{pr_num}")
            elif merge_status == 405:
                BUFFER.append(f"   ⚠️  Branch protection blocks merge")
                skipped_count += 1
            elif merge_status == 409:
                BUFFER.append(f"   ⚠️  Merge conflict")
                # Race: GitHub said mergeable but merge hit a conflict (stale
                # mergeable state). Resolve via Claude Code once per head SHA.
                if AI_FIX_ENABLED and not already:
                    valid, _new_sha, _new_mergeable, _reason = check_pr_still_valid(
                        token, repo_full, pr_num, head_sha
                    )
                    if valid:
                        BUFFER.append(f"   🤖 Resolving merge conflict with Claude Code...")
                        kill_orphaned_claude(repo_full, pr_num)
                        fixed, summary = run_ai_fix(
                            repo_full, pr_num, title, head_sha, head_ref, base_ref, token
                        )
                        if fixed:
                            BUFFER.append(f"   ✨ Conflict resolved: {summary}")
                            fixed_count += 1
                            mark_fixed(fix_state, repo_full, pr_num, head_sha)
                            BUFFER.append(f"   🔄 Will re-merge next tick after CI settles")
                            skipped_count += 1
                            continue
                        else:
                            BUFFER.append(f"   ⏭️  Conflict fix failed: {summary}")
                            if summary.startswith("[INFRA]"):
                                reason = summary.replace("[INFRA] ", "")
                            else:
                                reason = "Unresolvable merge conflict (Claude Code made no push)"
                            mark_skip(fix_state, repo_full, pr_num, head_sha, reason)
                            if notify_skip_once(fix_state, repo_full, pr_num, head_sha, reason):
                                BUFFER.append(f"   🔔 Skip notified: {reason}")
                            skipped_count += 1
                            continue
                BUFFER.append(f"   ⏭️  Skipping (409 conflict, already attempted)")
                skipped_count += 1
            else:
                BUFFER.append(f"   ⚠️  Merge: HTTP {merge_status}")
                post_discord_notification(repo_full, pr_num, "failed",
                                          summary=f"Merge failed HTTP {merge_status}: {merge_data.get('message','')}",
                                          score=score,
                                          url=f"https://github.com/{repo_full}/pull/{pr_num}")
                skipped_count += 1

        # Summary
        elapsed = time.time() - start
        BUFFER.append(f"\n{'='*50}")
        BUFFER.append(f"📊 Summary ({elapsed:.1f}s)")
        if AI_FIX_ENABLED:
            BUFFER.append(f"   ✨ AI fixes applied: {fixed_count}")
        BUFFER.append(f"   ✅ Merged: {merged_count}")
        BUFFER.append(f"   📡 Reviews triggered: {triggered_count}")
        BUFFER.append(f"   ⏭️  Skipped: {skipped_count}")
        BUFFER.append(f"{'='*50}")

        flush_log()

    finally:
        release_lock()


if __name__ == "__main__":
    # SIGTERM (cron kill / maintenance) must not leave a stale lockfile
    # blocking the next tick. Trap it so the finally in main() runs.
    import signal as _signal

    def _term_handler(signum, _frame):
        release_lock()
        raise SystemExit(128 + signum)

    _signal.signal(_signal.SIGTERM, _term_handler)

    # ── Manual/dev entrypoints for the upstream fork sync ──
    #   python3 pr-queue-worker.py --sync-status
    #   python3 pr-queue-worker.py --sync-only owner/fork [--dry]
    # --dry prepares the merge (including the Claude Code conflict resolution)
    # in /tmp/pr-queue-sync-work/<repo> and stops before pushing.
    _argv = sys.argv[1:]
    if "--sync-status" in _argv:
        print(json.dumps(load_sync_state(), indent=2))
        sys.exit(0)
    if "--sync-only" in _argv:
        _idx = _argv.index("--sync-only")
        _target = (_argv[_idx + 1]
                   if len(_argv) > _idx + 1 and not _argv[_idx + 1].startswith("-")
                   else None)
        _dry = "--dry" in _argv
        if not get_lock():
            print("another pr-queue-worker run holds the lock — try again shortly")
            sys.exit(1)
        try:
            _report = run_upstream_sync(only=_target, dry=_dry)
        finally:
            release_lock()
        print("\n".join(_report) if _report else "(nothing to sync)")
        sys.exit(0)

    main()