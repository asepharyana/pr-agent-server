#!/usr/bin/env python3
"""Quick callback server to receive GitHub App credentials after manifest creation"""
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/hermes-agent/.venv/lib/python3.12/site-packages"))

from fastapi import FastAPI, Request
import uvicorn

app = FastAPI()

@app.get("/setup/callback")
@app.post("/setup/callback")
async def callback(request: Request):
    params = dict(request.query_params)
    print(f"[CALLBACK] Received params: {json.dumps(params, indent=2)}")
    
    # If we got a code, exchange it for credentials
    if "code" in params:
        import httpx
        code = params["code"]
        print(f"[CALLBACK] Exchanging code: {code[:20]}...")
        
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://api.github.com/app-manifests/{code}/conversions",
                headers={"Accept": "application/vnd.github.v3+json"}
            )
            if resp.status_code == 201:
                data = resp.json()
                # Save credentials
                creds = {
                    "app_id": data.get("id"),
                    "app_slug": data.get("slug"),
                    "pem": data.get("pem"),
                    "webhook_secret": data.get("webhook_secret"),
                    "client_id": data.get("client_id"),
                    "client_secret": data.get("client_secret")
                }
                with open("/opt/pr-agent-server/app_credentials.json", "w") as f:
                    json.dump(creds, f, indent=2)
                print(f"[CALLBACK] App created! ID: {creds['app_id']}, Slug: {creds['app_slug']}")
                return {"status": "success", "app_id": creds["app_id"], "app_slug": creds["app_slug"]}
            else:
                print(f"[CALLBACK] Exchange failed: {resp.status_code} - {resp.text}")
                return {"status": "error", "detail": resp.text}
    
    return {"status": "waiting", "params": params}

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=3000, log_level="info")
