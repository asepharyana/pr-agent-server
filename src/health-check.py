#!/usr/bin/env python3
"""
PR-Agent Model Health Watchdog
===============================
Runs every 10 minutes via Hermes no_agent cron. Tests the exact model config
the pr-agent server uses (primary + fallbacks) against 9router via raw HTTP.

Output contract (no_agent cron):
  - OK → empty stdout (silent, $0 idle)
  - FAIL → one-line alert + detail (delivered to Discord/home channel)

Design: alert only when EVERY configured model fails (primary AND all
fallbacks). If any model works, the server's own fallback chain will succeed,
so the system is healthy even if the primary is down/slow. This prevents
false alerts from a single slow/failed model.

Key resolution order (no hardcoding):
  1. On-disk key file maintained by sync-key.py (source of truth for the
     running server — always current after every service start/restart).
  2. BWS_ACCESS_TOKEN env var (shell wrapper or gateway-injected).
  3. /etc/bws-token file → bws secret get (with sudo fallback for
     non-root processes).
"""
import os, sys, json, hashlib, subprocess
from pathlib import Path

# Configurable paths — no hardcoding; everything reads from env or known
# locations that the Nix build / systemd unit define.
BWS_SECRET_ID = os.environ.get(
    "BWS_ROUTER_KEY_SECRET_ID", "2aef2194-971d-4dae-99dd-b49a0041f97c"
)
ROUTER_BASE = os.environ.get(
    "ROUTER_BASE_URL", "https://9router.asepharyana.my.id/v1"
)
PRIMARY = os.environ.get("HEALTH_CHECK_PRIMARY_MODEL", "openai/claude-opus-5")
FALLBACKS = os.environ.get(
    "HEALTH_CHECK_FALLBACK_MODELS",
    "openai/claude-sonnet-5,openai/claude-haiku-4-5-20251001,openai/ATLAS,openai/gemini,openai/text,openai/deepseek-v4-flash-free"
).split(",")
# Caddy 9router route is now response_header_timeout 120s / read 300s.
# LLM combo TTFT often 30-40s+. Give the check room to complete.
HTTP_TIMEOUT = int(os.environ.get("HEALTH_CHECK_HTTP_TIMEOUT", "150"))
CONSECUTIVE_FAIL_FILE = Path(
    os.environ.get("HEALTH_CHECK_FAIL_COUNT_FILE", "/tmp/pr-agent-health-fail-count")
)

# ── key resolution ──────────────────────────────────────────────────────────

# On-disk key file — maintained by sync-key.py (runs on every service start
# via systemd ExecStartPre). This is the SAME key the server uses, always
# current, no BWS dependency.
APP_DIR = Path(os.environ.get("PR_AGENT_APP_DIR", "/var/lib/pr-agent-server"))
KEYFILE = APP_DIR / "omniroute_key"


def _read_key_from_disk() -> str:
    """Read the router key from the on-disk file maintained by sync-key.py.
    This is the primary source — always current after service start."""
    try:
        if KEYFILE.is_file():
            key = KEYFILE.read_text().strip()
            if len(key) >= 10:
                return key
    except (PermissionError, OSError):
        pass
    return ""


def _read_token() -> str:
    """Read BWS access token. Direct read fails for non-root (root:bws 640),
    so fall back to `sudo -n cat` (cron user `code` is in sudo group, NOPASSWD)."""
    # Try direct read first (works when gateway has bws group)
    for path in (Path("/etc/bws-token"),):
        try:
            if path.is_file():
                return path.read_text().strip()
        except PermissionError:
            pass
    # Fallback: sudo (works when user has NOPASSWD sudo)
    try:
        r = subprocess.run(
            ["sudo", "-n", "cat", "/etc/bws-token"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""


def _fetch_key_from_bws() -> str:
    """Fetch the router key from BWS via the bws CLI."""
    token = os.environ.get("BWS_ACCESS_TOKEN", "")
    if not token:
        token = _read_token()
    if not token:
        return ""
    env = {**os.environ, "BWS_ACCESS_TOKEN": token}
    try:
        r = subprocess.run(
            ["/usr/local/bin/bws", "secret", "get", BWS_SECRET_ID, "--output", "env"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        if r.returncode != 0:
            return ""
        # Value is shell-quoted KEY="value" — take first line only.
        line = r.stdout.split("\n")[0]
        if "=" not in line:
            return ""
        val = line.split("=", 1)[1].strip().strip('"')
        if len(val) < 10:
            return ""
        return val
    except Exception:
        return ""


def get_key() -> str:
    """Resolve the router API key. Order: on-disk file → BWS CLI.
    The on-disk file is always current (sync-key runs on every service start)
    and has zero external dependencies — preferred path for the health check."""
    # 1. On-disk file (fast, no subprocess, no BWS dependency)
    key = _read_key_from_disk()
    if key:
        return key
    # 2. BWS CLI fallback (for edge cases where the file is missing/stale)
    key = _fetch_key_from_bws()
    return key


# ── health check ────────────────────────────────────────────────────────────

def check_model(model: str, key: str) -> tuple:
    """Returns (ok: bool, detail: str). Uses raw HTTP (no litellm dependency).

    NOTE: litellm strips the 'openai/' provider prefix before sending the
    request body. 9router resolves bare aliases (e.g. 'claude-opus-5') to
    its own routing; WITH the prefix it tries the 'openai' provider upstream,
    which has no credentials → 404 'No active credentials for provider: openai'.
    So we strip the prefix here to mirror exactly what the server sends.
    """
    bare = model.split("/", 1)[-1] if "/" in model else model
    import urllib.request, urllib.error
    body = json.dumps({
        "model": bare,
        "messages": [{"role": "user", "content": "Reply with the single word OK"}],
        "max_tokens": 10,
    }).encode()
    req = urllib.request.Request(
        f"{ROUTER_BASE}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return r.status == 200, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        err = e.read().decode(errors="replace")[:160].replace("\n", " ")
        return False, f"HTTP {e.code}: {err}"
    except Exception as e:
        return False, f"{type(e).__name__}: {str(e)[:120]}"


def main() -> int:
    key = get_key()
    if not key:
        print(
            "⚠️ pr-agent health: cannot resolve router key "
            "(on-disk file missing and BWS unavailable)"
        )
        return 1

    results = {}
    ok_somewhere = False
    results[PRIMARY] = check_model(PRIMARY, key)
    ok_somewhere = ok_somewhere or results[PRIMARY][0]
    if not ok_somewhere:
        for fb in FALLBACKS:
            results[fb] = check_model(fb, key)
            if results[fb][0]:
                ok_somewhere = True
                break  # bound runtime; one working model is enough
        else:
            # ensure every fallback appears in results for the report
            for fb in FALLBACKS:
                results.setdefault(fb, (False, "not tested (prior model failed)"))
    else:
        for fb in FALLBACKS:
            results.setdefault(fb, (True, "not checked (primary ok)"))

    # Any model working = server's fallback chain will succeed = healthy.
    if ok_somewhere:
        CONSECUTIVE_FAIL_FILE.unlink(missing_ok=True)
        return 0

    # Every model failed. Count consecutive to avoid flapping on 1-off glitch.
    failures = [f"{m} → {d}" for m, (ok, d) in results.items() if not ok]
    n = 1
    if CONSECUTIVE_FAIL_FILE.exists():
        try:
            n = int(CONSECUTIVE_FAIL_FILE.read_text().strip()) + 1
        except ValueError:
            n = 1
    CONSECUTIVE_FAIL_FILE.write_text(str(n))

    if n < 2:
        return 0

    detail = " | ".join(failures)
    key_hash = hashlib.sha256(key.encode()).hexdigest()[:8]
    print(f"🚨 pr-agent MODELS FAILING ({n} consecutive checks)\n{detail}\nkey hash {key_hash}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
