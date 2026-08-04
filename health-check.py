#!/usr/bin/env python3
"""
PR-Agent Model Health Watchdog
===============================
Runs every 10 minutes via Hermes no_agent cron. Tests the exact model config
the pr-agent server uses (primary + fallbacks) against 9router via litellm.

Output contract (no_agent cron):
  - OK → empty stdout (silent, $0 idle)
  - FAIL → one-line alert + detail (delivered to Discord/home channel)
"""
import os, sys, json, hashlib, subprocess
from pathlib import Path

BWS_SECRET_ID = "2aef2194-971d-4dae-99dd-b49a0041f97c"
ROUTER_BASE = "https://9router.asepharyana.my.id/v1"
PRIMARY = "openai/claude-opus-4-8"
FALLBACKS = ["openai/ATLAS", "openai/gemini", "openai/text", "openai/deepseek-v4-flash-free"]
CONSECUTIVE_FAIL_FILE = Path("/tmp/pr-agent-health-fail-count")

# ── key from BWS ────────────────────────────────────────────────────────────
def get_key() -> str:
    token = os.environ.get("BWS_ACCESS_TOKEN", "")
    if not token and Path("/etc/bws-token").is_file():
        token = Path("/etc/bws-token").read_text().strip()
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
        # appends "# one or more secrets have been commented-out..." after a
        # problematic key rename; only the first line is the real key value.
        line = r.stdout.split("\n")[0]
        if "=" not in line:
            return ""
        val = line.split("=", 1)[1].strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        return val
    except Exception:
        return ""


# ── health check ────────────────────────────────────────────────────────────
def check_model(model: str, key: str) -> tuple:
    """Returns (ok: bool, detail: str). Uses raw HTTP (no litellm dependency).

    NOTE: litellm strips the 'openai/' provider prefix before sending the
    request body. 9router resolves bare aliases (e.g. 'claude-opus-4-8') to
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
        with urllib.request.urlopen(req, timeout=60) as r:
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

    failures = []
    ok_primary, detail = check_model(PRIMARY, key)
    if not ok_primary:
        failures.append(f"primary {PRIMARY} → {detail}")
    for fb in FALLBACKS:
        ok, d = check_model(fb, key)
        if not ok:
            failures.append(f"fallback {fb} → {d}")

    if not failures:
        # healthy — clear counter, stay silent
        CONSECUTIVE_FAIL_FILE.unlink(missing_ok=True)
        return 0

    # At least one model failed. Count consecutive failures to avoid flapping.
    n = 1
    if CONSECUTIVE_FAIL_FILE.exists():
        try:
            n = int(CONSECUTIVE_FAIL_FILE.read_text().strip()) + 1
        except ValueError:
            n = 1
    CONSECUTIVE_FAIL_FILE.write_text(str(n))

    if n < 2:
        # first failure — could be transient, stay quiet
        return 0

    detail = " | ".join(failures)
    key_hash = hashlib.sha256(key.encode()).hexdigest()[:8]
    print(f"🚨 pr-agent MODELS FAILING ({n} consecutive checks)\n{detail}\nkey hash {key_hash}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
