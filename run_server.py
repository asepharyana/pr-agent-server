#!/usr/bin/env python3
"""PR-Agent GitHub App + manifest callback server"""
import os, sys, json

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
os.environ["OPENAI__API_BASE"] = os.environ.get(
    "OPENAI_API_BASE", "https://omniroute.imrnes.team/v1"
)
os.environ["OPENAI__KEY"] = omni_key
os.environ["CONFIG__MODEL"] = os.environ.get("PR_AGENT_MODEL", "openai/claude-opus-4-8")
os.environ["CONFIG__FALLBACK_MODELS"] = os.environ.get(
    "PR_AGENT_FALLBACK_MODELS",
    '["openai/ATLAS","openai/gemini","openai/text","openai/deepseek-v4-flash-free"]',
)
os.environ["CONFIG__CUSTOM_MODEL_MAX_TOKENS"] = os.environ.get(
    "PR_AGENT_MAX_TOKENS", "128000"
)
os.environ["GITHUB_APP__PR_COMMANDS"] = os.environ.get(
    "PR_AGENT_PR_COMMANDS",
    '["/review --pr_reviewer.require_score_review=true --pr_reviewer.require_security_review=true","/describe","/improve"]',
)

sys.path.insert(0, APP_DIR)
from pr_agent.servers.github_app import app as pr_agent_app, router as pr_router
from fastapi import FastAPI, Request
import uvicorn
import httpx

from starlette.middleware import Middleware
from starlette_context.middleware import RawContextMiddleware

app = FastAPI(middleware=[Middleware(RawContextMiddleware)])
app.include_router(pr_router)


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
    return {"status": "ok"}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    print(f"PR-Agent GitHub App server starting...")
    print(f"  App ID: {os.environ.get('GITHUB_APP_ID', '')}")
    print(f"  Model: {os.environ.get('PR_AGENT_MODEL', 'openai/claude-opus-4-8')} via omniroute")
    print(f"  Endpoint: /api/v1/github_webhooks")
    print(f"  Port: {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
