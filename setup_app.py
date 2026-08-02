#!/usr/bin/env python3
"""
PR-Agent GitHub App Setup Helper
Creates the GitHub App manifest and prepares the server configuration.
"""
import json
import base64
import os
import secrets

# ============================================================
# CONFIGURATION
# ============================================================
APP_NAME = "pr-agent-auto"
APP_SLUG = "pr-agent-auto"
DESCRIPTION = "Automated PR review and merge bot powered by AI"
HOME_URL = "https://github.com/asepharyana"
PUBLIC_IP = "45.127.35.244"
PORT = 4002
WEBHOOK_URL = "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks"
REDIRECT_URL = "https://pr-agent.asepharyana.my.id/app-setup-complete"
CALLBACK_URLS = ["https://pr-agent.asepharyana.my.id/callback"]

# Generate webhook secret
WEBHOOK_SECRET = secrets.token_hex(20)

# ============================================================
# CREATE MANIFEST
# ============================================================
manifest = {
    "name": APP_NAME,
    "slug": APP_SLUG,
    "description": DESCRIPTION,
    "url": HOME_URL,
    "hook_attributes": {
        "url": WEBHOOK_URL,
        "active": True
    },
    "redirect_url": REDIRECT_URL,
    "callback_urls": CALLBACK_URLS,
    "public": False,
    "default_events": [
        "pull_request",
        "issue_comment",
        "push"
    ],
    "default_permissions": {
        "pull_requests": "write",
        "issues": "write",
        "metadata": "read",
        "contents": "read",
        "checks": "write",
        "emails": "read"
    }
}

# Save manifest
os.makedirs("/opt/pr-agent-server", exist_ok=True)
manifest_path = "/opt/pr-agent-server/manifest.json"

with open(manifest_path, "w") as f:
    json.dump(manifest, f, indent=2)

# Create the URL
manifest_b64 = base64.b64encode(json.dumps(manifest).encode()).decode()
manifest_url = f"https://github.com/settings/apps/new?manifest={manifest_b64}"

print("=" * 60)
print("PR-Agent GITHUB APP SETUP")
print("=" * 60)
print(f"\n📋 App Name: {APP_NAME}")
print(f"🌐 Webhook URL: {WEBHOOK_URL}")
print(f"🔑 Webhook Secret: {WEBHOOK_SECRET}")
print(f"\n{'=' * 60}")
print("STEP 1: Click this URL to create the GitHub App:")
print(f"{'=' * 60}")
print(f"\n{manifest_url}\n")
print(f"{'=' * 60}")
print("STEP 2: After clicking 'Create GitHub App', you'll be redirected.")
print("   Save the App ID, Private Key, and Webhook Secret shown.")
print(f"{'=' * 60}")

# Save vars for later use
env_file = "/opt/pr-agent-server/.env"
with open(env_file, "w") as f:
    f.write(f"WEBHOOK_SECRET={WEBHOOK_SECRET}\n")
    f.write(f"PORT={PORT}\n")
    f.write("# After GitHub App creation, add:\n")
    f.write("# APP_ID=<your-app-id>\n")
    f.write("# PRIVATE_KEY_PATH=/opt/pr-agent-server/private-key.pem\n")
    f.write(f"# GITHUB_APP_NAME={APP_NAME}\n")

print(f"\n📁 Config saved to: {manifest_path}")
print(f"📁 Env file: {env_file}")
print(f"\nWebhook Secret (save this!): {WEBHOOK_SECRET}")
