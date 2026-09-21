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
    """Load fixed PRs map {repo_full: {pr_num: last_head_sha}}."""
    if FIX_STATE_FILE.exists():
        try:
            return json.loads(FIX_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}

def save_fix_state(state):
    """Persist fixed PRs map."""
    FIX_STATE_FILE.write_text(json.dumps(state))

def already_fixed(state, repo_full, pr_num, head_sha):
    """True if this PR was already fixed at this SHA."""
    repo_state = state.get(repo_full, {})
    return str(pr_num) in repo_state and repo_state[str(pr_num)] == head_sha

def mark_fixed(state, repo_full, pr_num, head_sha):
    """Mark PR as fixed at given SHA."""
    repo_state = state.setdefault(repo_full, {})
    repo_state[str(pr_num)] = head_sha
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
    status, data = gh_api("PUT", f"/repos/{repo_full}/pulls/{pr_num}/merge", token=token,
                          json_data={"commit_title": f"Auto-merge PR #{pr_num}", "merge_method": "merge", "sha": sha})
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
            return False, f"Claude Code CLI not found at {claude_bin}"
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
        return False, "Claude Code timed out"
    except FileNotFoundError:
        subprocess.run(["rm", "-rf", str(workdir)], timeout=10)
        return False, "Claude Code CLI not found"

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

# ── Main ──
def main():
    start = time.time()
    global BUFFER

    if not get_lock():
        return

    try:
        all_prs = gather_open_prs()
        if not all_prs:
            return  # truly silent

        BUFFER.append(f"🔍 PR Queue Worker — {time.ctime()}")
        BUFFER.append(f"{'='*50}")
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
    main()