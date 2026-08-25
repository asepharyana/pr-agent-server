#!/usr/bin/env python3
"""PR-Agent GitHub App + manifest callback server"""
import os, sys, json, time, glob
from pathlib import Path

# Configurable paths (systemd Nix deployment keeps secrets outside the store)
APP_DIR = os.environ.get("PR_AGENT_APP_DIR", "/var/lib/pr-agent-server")
private_key_path = os.environ.get(
    "PRIVATE_KEY_PATH", os.path.join(APP_DIR, "private-key.pem")
)
omni_key_path = os.environ.get(
    "OMNIROUTE_KEY_PATH", os.path.join(APP_DIR, "omniroute_key")
)

with open(private_key_path) as f:
    private_key = f.read()

os.environ["GITHUB__DEPLOYMENT_TYPE"] = "app"
os.environ["GITHUB__APP_ID"] = os.environ.get("GITHUB_APP_ID", "4319749")
os.environ["GITHUB__PRIVATE_KEY"] = private_key
os.environ["GITHUB__WEBHOOK_SECRET"] = os.environ.get("GITHUB_WEBHOOK_SECRET", "")

with open(omni_key_path) as f:
    omni_key = f.read().strip()

# ── LLM provider routing ─────────────────────────────────────────
# 9router (and omniroute) reject ALL provider prefixes in the model name
# (e.g. `openai/claude-...`).  Models are specified bare, e.g. `claude-opus-5`.
# litellm, however, routes a bare `claude-*` name to the **Anthropic native**
# provider — which needs its own base URL / key env vars.  So we map the
# 9router endpoint + key onto `ANTHROPIC_API_BASE` / `ANTHROPIC_API_KEY`
# instead of the OpenAI-shaped `OPENAI__API_BASE` / `OPENAI__KEY` that litellm
# would only honour when the model carries an `openai/` prefix.
#
# Verified working:
#   $ litellm.completion(model="claude-opus-5", ...) with the env below → 200
_llm_base = os.environ.get("OPENAI_API_BASE", "https://9router.asepharyana.my.id/v1")
os.environ["ANTHROPIC_API_BASE"] = _llm_base
os.environ["ANTHROPIC_API_KEY"] = omni_key
os.environ["OPENAI_API_BASE"] = _llm_base
os.environ["OPENAI_API_KEY"] = omni_key

os.environ["CONFIG__MODEL"] = os.environ.get("PR_AGENT_MODEL", "claude-opus-5")
os.environ["CONFIG__FALLBACK_MODELS"] = os.environ.get(
    "PR_AGENT_FALLBACK_MODELS",
    '["claude-sonnet-5","claude-haiku-4-5-20251001"]',
)
os.environ["CONFIG__CUSTOM_MODEL_MAX_TOKENS"] = os.environ.get(
    "PR_AGENT_MAX_TOKENS", "128000"
)
# 9router (omniroute) is latency-tolerant but PR-Agent's default litellm
# timeout (~60-90s) is too short for 15k-token review prompts ->
# AnthropicException Timeout.  Raise it so the full context fits.
# PR-Agent uses Dynaconf with prefix `PR_AGENT`; the `ai_timeout` field
# lives under the [config] section, so the env key is `PR_AGENT__AI_TIMEOUT`.
os.environ.setdefault("PR_AGENT__AI_TIMEOUT", "300")
os.environ.setdefault("LITELLM_REQUEST_TIMEOUT", "300")
os.environ["GITHUB_APP__PR_COMMANDS"] = os.environ.get(
    "PR_AGENT_PR_COMMANDS",
    '["/review --pr_reviewer.require_score_review=true --pr_reviewer.require_security_review=true","/describe","/improve"]',
)

# Analytics folder for PR-Agent structured logs (analytics=True records)
ANALYTICS_DIR = os.environ.get("PR_AGENT_ANALYTICS_DIR", "/var/lib/pr-agent-server/analytics")
os.makedirs(ANALYTICS_DIR, exist_ok=True)
os.environ["CONFIG__ANALYTICS_FOLDER"] = ANALYTICS_DIR

# Discord webhook for notifications (from BWS secret DISCORD_WEBHOOK_URL)
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "")
DISCORD_ALERT_WEBHOOK_URL = os.environ.get("DISCORD_ALERT_WEBHOOK_URL", "")

sys.path.insert(0, APP_DIR)
from pr_agent.servers.github_app import app as pr_agent_app, router as pr_router
from pr_agent.config_loader import get_settings
from fastapi import FastAPI, Request
import uvicorn
import httpx

from starlette.middleware import Middleware
from starlette_context.middleware import RawContextMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse

app = FastAPI(middleware=[Middleware(RawContextMiddleware)])
app.include_router(pr_router)

# ── Override litellm request timeout ──────────────────────────────────────
# PR-Agent's Dynaconf config uses `envvar_prefix=False` (env vars disabled)
# and `.toml` files only, so PR_AGENT__AI_TIMEOUT does NOT work.
# We monkey-patch the loaded settings + litellm global so the long
# 15k-token review diffs via 9router get 300s instead of the default 120s.
try:
    _s = get_settings()
    _s.config["ai_timeout"] = 300
except Exception:
    pass
import litellm as _litellm
# Force a higher request timeout — PR-Agent passes `timeout=120` (from
# configuration.toml `ai_timeout=120`) to litellm.completion, which overrides
# the global `litellm.request_timeout`.  9router/claude-opus-5 needs more
# time for 15k-token review diffs.  We wrap acompletion() to clamp the kwarg.
from pr_agent.algo.ai_handlers import litellm_ai_handler as _laih

_orig_acompletion = _laih.acompletion


async def _patched_acompletion(*args, **kwargs):
    t = kwargs.get("timeout")
    if t is not None and float(t) <= 120:
        kwargs["timeout"] = 600
    return await _orig_acompletion(*args, **kwargs)


_laih.acompletion = _patched_acompletion
_litellm.request_timeout = 600



# ── Analytics / Metrics ─────────────────────────────────────────────────────
def _read_analytics_logs(max_files: int = 5) -> list:
    """Parse PR-Agent analytics JSON logs (analytics=True records).

    Real log lines look like:
      {"text": "...", "record": {"elapsed": {...}, "extra": {"command": "...", "pr_url": "..."},
       "file": {...}, "function": "...", "level": {"name": "INFO", ...},
       "message": "...", "module": "...", "process": {...}, "thread": {...},
       "time": {"repr": "2026-08-04 ...", "timestamp": ...}}}
    """
    records = []
    files = sorted(glob.glob(os.path.join(ANALYTICS_DIR, "pr-agent.*.log")))
    for f in files[-max_files:]:
        try:
            with open(f) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    # PR-Agent wraps under "record": {...}
                    if "record" in rec and isinstance(rec["record"], dict):
                        rec = rec["record"]
                    extra = rec.get("extra", {}) or {}
                    if "artifact" in extra and isinstance(extra["artifact"], dict):
                        extra.update(extra.pop("artifact"))
                    rec["_extra"] = extra
                    rec["_file"] = Path(f).name
                    records.append(rec)
        except FileNotFoundError:
            continue
    return records


@app.get("/api/metrics")
async def metrics():
    """Prometheus-style metrics for the PR-Agent server."""
    records = _read_analytics_logs()
    total = len(records)
    failed = 0
    success = 0
    command_counts = {}
    model_failures = {}
    for rec in records:
        extra = rec.get("_extra", {})
        cmd = extra.get("command", "unknown")
        command_counts[cmd] = command_counts.get(cmd, 0) + 1
        msg = rec.get("message", "")
        if "Failed to generate" in msg or "error" in msg.lower() and rec.get("level", {}).get("name", "") == "WARNING":
            failed += 1
            model = extra.get("model", "unknown")
            model_failures[model] = model_failures.get(model, 0) + 1
        else:
            success += 1
    lines = [
        "# HELP pr_agent_requests_total Total PR-Agent analytics events",
        "# TYPE pr_agent_requests_total counter",
        f'pr_agent_requests_total{{status="success"}} {success}',
        f'pr_agent_requests_total{{status="failed"}} {failed}',
        "# HELP pr_agent_requests_by_command PR-Agent events by command",
        "# TYPE pr_agent_requests_by_command counter",
    ]
    for cmd, cnt in sorted(command_counts.items()):
        lines.append(f'pr_agent_requests_by_command{{command="{cmd}"}} {cnt}')
    lines.append("# HELP pr_agent_model_failures PR-Agent model failures by model")
    lines.append("# TYPE pr_agent_model_failures counter")
    for model, cnt in sorted(model_failures.items()):
        lines.append(f'pr_agent_model_failures{{model="{model}"}} {cnt}')
    return PlainTextResponse(
        "\n".join(lines) + "\n",
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


@app.get("/api/analytics")
async def analytics():
    """JSON analytics summary — recent events + failure breakdown."""
    records = _read_analytics_logs()
    recent = []
    for rec in records[-30:]:
        extra = rec.get("_extra", {})
        recent.append(
            {
                "time": rec.get("time", {}).get("repr", ""),
                "command": extra.get("command", ""),
                "message": rec.get("message", ""),
                "pr_url": extra.get("pr_url", ""),
                "model": extra.get("model", ""),
                "level": rec.get("level", {}).get("name", ""),
            }
        )
    failures = [r for r in records if "Failed to generate" in r.get("message", "")]
    return {
        "total_events": len(records),
        "failure_count": len(failures),
        "recent": recent,
        "failures": [
            {
                "time": r.get("time", {}).get("repr", ""),
                "command": r.get("_extra", {}).get("command", ""),
                "model": r.get("_extra", {}).get("model", ""),
                "message": r.get("message", "")[:200],
            }
            for r in failures[-20:]
        ],
    }


# ── Discord notifications ───────────────────────────────────────────────────
async def _send_discord(webhook: str, content: str, title: str = "", color: int = 0x5865F2):
    """Fire-and-forget Discord webhook message. Never raises."""
    if not webhook:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                webhook,
                json={
                    "username": "PR-Agent Ops",
                    "embeds": [{"title": title, "description": content[:4000], "color": color}],
                },
            )
            return resp.status_code in (200, 204)
    except Exception:
        return False


@app.post("/api/v1/notify_review")
async def notify_review(request: Request):
    """Internal endpoint: pr-agent/queue worker posts here after a review completes."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    repo = body.get("repo", "")
    pr_num = body.get("pr", "")
    status = body.get("status", "done")  # done | failed
    summary = body.get("summary", "")
    score = body.get("score", "")
    url = body.get("url", "")

    if status == "failed":
        await _send_discord(
            DISCORD_ALERT_WEBHOOK_URL or DISCORD_WEBHOOK_URL,
            f"**{repo}** PR #{pr_num} review FAILED\n```{summary}```\n{url}",
            title="🚨 PR-Agent Review Failed",
            color=0xED4245,
        )
    else:
        await _send_discord(
            DISCORD_WEBHOOK_URL,
            f"**{repo}** PR #{pr_num} reviewed" + (f" — score {score}/10" if score else "") + f"\n{summary}\n{url}",
            title="✅ PR-Agent Review Complete",
            color=0x57F287,
        )
    return {"ok": True}


@app.get("/setup/callback")
@app.post("/setup/callback")
async def callback(request: Request):
    params = dict(request.query_params)
    if "code" in params:
        code = params["code"]
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://api.github.com/app-manifests/{code}/conversions",
                headers={"Accept": "application/vnd.github.v3+json"},
            )
            if resp.status_code == 201:
                data = resp.json()
                creds = {
                    "app_id": data.get("id"),
                    "pem": data.get("pem"),
                    "webhook_secret": data.get("webhook_secret"),
                    "slug": data.get("slug"),
                }
                with open(os.path.join(APP_DIR, "credentials_callback.json"), "w") as f:
                    json.dump(creds, f, indent=2)
                return {
                    "status": "success",
                    "app_id": creds["app_id"],
                    "slug": creds["slug"],
                }
    return {"status": "ok", "message": "callback received"}


@app.get("/health")
async def health():
    return {"status": "ok", "model": os.environ.get("PR_AGENT_MODEL", "")}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    print(f"PR-Agent GitHub App server starting...")
    print(f"  App ID: {os.environ.get('GITHUB_APP_ID', '')}")
    print(f"  Model: {os.environ.get('PR_AGENT_MODEL', 'openai/claude-opus-5')} via omniroute")
    print(f"  Endpoint: /api/v1/github_webhooks")
    print(f"  Analytics: {ANALYTICS_DIR}")
    print(f"  Port: {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
