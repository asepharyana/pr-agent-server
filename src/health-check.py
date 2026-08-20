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
"""
import os, sys, json, hashlib, subprocess
from pathlib import Path

BWS_SECRET_ID = "2aef2194-971d-4dae-99dd-b49a0041f97c"
ROUTER_BASE = "https://9router.asepharyana.my.id/v1"
PRIMARY = "openai/claude-opus-5"
FALLBACKS = ["openai/claude-sonnet-5", "openai/claude-haiku-4-5-20251001", "openai/ATLAS", "openai/gemini", "openai/text", "openai/deepseek-v4-flash-free"]
# Caddy 9router route is now response_header_timeout 120s / read 300s.
# LLM combo TTFT often 30-40s+. Give the check room to complete.
HTTP_TIMEOUT = 150
CONSECUTIVE_FAIL_FILE = Path("/tmp/pr-agent-health-fail-count")

# ── key from BWS ────────────────────────────────────────────────────────────
def _read_token() -> str:
    """Read BWS token. Direct read fails for non-root (root:bws 640), so fall
    back to `sudo -n cat` (cron user `code` is in sudo group, NOPASSWD)."""
    for path in (Path("/etc/bws-token"),):
        try:
            if path.is_file():
                return path.read_text().strip()
        except PermissionError:
            pass
    try:
        r = subprocess.run(["sudo", "-n", "cat", "/etc/bws-token"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""

def get_key() -> str:
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
        # Value is shell-quoted KEY="value" — take first line only. BWS sometimes
        # appends "# one or more secrets have been commented-out..."; only the
        # first line is the real key value.
        line = r.stdout.split("\n")[0]
        if "=" not in line:
            return ""
        val = line.split("=", 1)[1].strip().strip('"')
        if len(val) < 10:
            return ""
        return val
    except Exception:
        return ""


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
        print("⚠️ pr-agent health: cannot fetch router key from BWS (bws unavailable)")
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