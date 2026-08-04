#!/usr/bin/env python3
"""
PR-Agent key auto-sync — fetch the working 9router key from Bitwarden Secrets
Manager (BWS) and write it to the on-disk omniroute_key file IF it differs.

Why: the on-disk key file is the single source of truth for the running
server (run_server.py reads it at startup). If BWS gets updated (key
rotation) and the file isn't refreshed, the server silently starts failing
with 401s — exactly what happened 2026-08-04 (stale 35-char key for 14h).

This script is invoked by systemd ExecStartPre= so every service start /
restart re-syncs the key before uvicorn boots. It is idempotent and
fail-open (on any BWS error it leaves the existing file untouched so the
service can still start).
"""
import os, sys, subprocess, hashlib
from pathlib import Path

APP_DIR = Path(os.environ.get("PR_AGENT_APP_DIR", "/var/lib/pr-agent-server"))
KEYFILE = APP_DIR / "omniroute_key"
# BWS secret that holds the working router key
BWS_SECRET_ID = os.environ.get("BWS_ROUTER_KEY_SECRET_ID", "2aef2194-971d-4dae-99dd-b49a0041f97c")
PROJECT_ID = "27210268-6134-47b3-9a68-b4980079d1ec"


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def bws_get_secret_value(secret_id: str) -> str:
    """Fetch a BWS secret value. Returns '' on any failure (fail-open)."""
    token = os.environ.get("BWS_ACCESS_TOKEN", "")
    if not token and Path("/etc/bws-token").is_file():
        token = Path("/etc/bws-token").read_text().strip()
    if not token:
        print("sync-key: no BWS_ACCESS_TOKEN", file=sys.stderr)
        return ""
    env = {**os.environ, "BWS_ACCESS_TOKEN": token}
    try:
        r = subprocess.run(
            ["/usr/local/bin/bws", "secret", "get", secret_id, "--output", "env"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        if r.returncode != 0:
            print(f"sync-key: bws get failed rc={r.returncode}: {r.stderr[:200]}", file=sys.stderr)
            return ""
        # Value is shell-quoted KEY="value" — take first line, strip quotes
        line = r.stdout.split("\n")[0]
        if "=" not in line:
            return ""
        val = line.split("=", 1)[1].strip()
        # Remove wrapping quotes (shlex could be used; simple strip is fine for keys)
        if val.startswith('"') and val.endswith('"'):
            val = val[1:-1]
        elif val.startswith("'") and val.endswith("'"):
            val = val[1:-1]
        return val
    except Exception as e:
        print(f"sync-key: bws error {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
        return ""


def main() -> int:
    new_key = bws_get_secret_value(BWS_SECRET_ID).strip()
    if not new_key:
        print("sync-key: no key from BWS, leaving existing file", file=sys.stderr)
        return 0  # fail-open

    if KEYFILE.exists():
        old = KEYFILE.read_text().strip()
        if old == new_key:
            print("sync-key: key already up to date (no change)")
            return 0

    # Write key with correct owner/perms (pr-agent user)
    try:
        import pwd
        pw = pwd.getpwnam("pr-agent")
        KEYFILE.write_text(new_key + "\n")
        os.chmod(KEYFILE, 0o600)
        os.chown(KEYFILE, pw.pw_uid, pw.pw_gid)
        print(f"sync-key: updated {KEYFILE} ({sha(new_key)[:12]}...)")
        return 0
    except Exception as e:
        print(f"sync-key: write failed {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
