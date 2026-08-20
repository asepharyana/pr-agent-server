#!/usr/bin/env python3
"""
PR-Agent GitHub App - Complete Setup & Server
Generates manifest URL, starts webhook server, handles callback
"""
import json, base64, secrets, os, sys, threading
from pathlib import Path

WEBHOOK_SECRET = secrets.token_hex(20)
BASE_DIR = Path("/opt/pr-agent-server")
BASE_DIR.mkdir(parents=True, exist_ok=True)

# ── 1. Generate Manifest ──
manifest = {
    "name": "pr-agent-auto",
    "url": "https://github.com/asepharyana",
    "hook_attributes": {
        "url": "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks",
        "active": True
    },
    "redirect_url": "https://pr-agent.asepharyana.my.id/setup/callback",
    "callback_urls": ["https://pr-agent.asepharyana.my.id/setup/callback"],
    "public": False,
    "default_events": ["pull_request", "issue_comment"],
    "default_permissions": {
        "pull_requests": "write",
        "issues": "write",
        "contents": "read",
        "metadata": "read",
        "checks": "write"
    }
}

manifest_b64 = base64.urlsafe_b64encode(json.dumps(manifest).encode()).decode()
manifest_url = f"https://github.com/settings/apps/new?manifest={manifest_b64}"

# ── 2. Save configs ──
with open(BASE_DIR / "manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
with open(BASE_DIR / "webhook_secret.txt", "w") as f:
    f.write(WEBHOOK_SECRET)
with open(BASE_DIR / "manifest_url.txt", "w") as f:
    f.write(manifest_url)

print(f"""
╔══════════════════════════════════════════════════╗
║        PR-Agent GitHub App Setup                ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  Webhook Secret: {WEBHOOK_SECRET[:20]}...  ║
║                                                  ║
║  MANIFEST URL:                                   ║
║  {manifest_url[:60]}...  ║
║                                                  ║
║  Buka URL di atas di browser GitHub              ║
║  asepharyana, klik Create, lalu kirim            ║
║  App ID + Private Key ke sini.                   ║
║                                                  ║
╚══════════════════════════════════════════════════╝
""")

# ── 3. Create .secrets.toml for PR-Agent ──
KEY = os.environ.get("OMNIROUTE_API_KEY", "")
secrets_toml = f"""[openai]
key = "{KEY}"
api_base = "https://omniroute.imrnes.team/v1"

[github]
deployment_type = "app"
# Will be filled after app creation:
# app_id = 123456
# private_key = "<paste PEM here>"
# webhook_secret = "{WEBHOOK_SECRET}"
"""

with open(BASE_DIR / ".secrets.toml", "w") as f:
    f.write(secrets_toml)

# ── 4. Create PR-Agent config ──
config_toml = """[config]
model = "openai/claude-opus-5"
fallback_models = ["openai/claude-sonnet-5", "openai/claude-haiku-4-5-20251001", "openai/ATLAS", "openai/gemini", "openai/text", "openai/deepseek-v4-flash-free"]
custom_model_max_tokens = 128000
git_provider = "github"
publish_output = true
verbosity_level = 0

[github_app]
pr_commands = ["/describe", "/review", "/improve"]
handle_push_trigger = true
push_commands = ["/describe", "/review"]

[pr_reviewer]
num_max_findings = 5
require_tests_review = true
require_security_review = true

[pr_description]
enable_pr_diagram = true
use_bullet_points = true

[pr_code_suggestions]
num_code_suggestions_per_chunk = 4
"""

with open(BASE_DIR / "configuration.toml", "w") as f:
    f.write(config_toml)

# ── 5. Create systemd service file ──
app_dir = os.path.expanduser("~/hermes-agent/.venv/lib/python3.12/site-packages")
service = f"""[Unit]
Description=PR-Agent GitHub App Webhook Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory={BASE_DIR}
Environment="PYTHONPATH={app_dir}"
Environment="OMNIROUTE_API_KEY={KEY}"
Environment="OPENAI_KEY={KEY}"
Environment="OPENAI_API_BASE=https://omniroute.imrnes.team/v1"
Environment="ANTHROPIC_API_KEY={KEY}"
Environment="ANTHROPIC_API_BASE=https://omniroute.imrnes.team/v1"
Environment="PORT=3000"
ExecStart={sys.executable} -c "from pr_agent.servers.github_app import app; import uvicorn; uvicorn.run(app, host='0.0.0.0', port=3000, log_level='info')"
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
"""

with open(BASE_DIR / "pr-agent.service", "w") as f:
    f.write(service)

print(f"  Config files created in {BASE_DIR}")
print(f"  Run: cp {BASE_DIR}/pr-agent.service /etc/systemd/system/")
print(f"  Then: systemctl daemon-reload && systemctl enable --now pr-agent")
