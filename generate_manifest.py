#!/usr/bin/env python3
"""Generate GitHub App manifest URL for PR-Agent"""
import json
import base64
import secrets

# Generate webhook secret
webhook_secret = secrets.token_hex(20)
print(f"Webhook Secret: {webhook_secret}")

manifest = {
    "name": "pr-agent-auto-review",
    "url": "https://github.com/asepharyana",
    "hook_attributes": {
        "url": f"http://45.127.35.244:3000/api/v1/github_webhooks",
        "active": True
    },
    "redirect_url": "http://45.127.35.244:3000/setup/callback",
    "callback_urls": ["http://45.127.35.244:3000/setup/callback"],
    "public": False,
    "default_events": [
        "pull_request",
        "issue_comment"
    ],
    "default_permissions": {
        "pull_requests": "write",
        "issues": "write",
        "contents": "read",
        "metadata": "read",
        "checks": "write"
    }
}

# Encode manifest to base64 URL-safe
manifest_json = json.dumps(manifest)
manifest_b64 = base64.urlsafe_b64encode(manifest_json.encode()).decode()

url = f"https://github.com/settings/apps/new?manifest={manifest_b64}"
print(f"\n{'='*60}")
print("MANIFEST URL (klik di browser GitHub asepharyana):")
print(f"{'='*60}")
print(url)
print(f"{'='*60}")

# Save for later
with open("/opt/pr-agent-server/manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)

with open("/opt/pr-agent-server/webhook_secret.txt", "w") as f:
    f.write(webhook_secret)

print(f"\nManifest saved to: /opt/pr-agent-server/manifest.json")
print(f"Webhook secret saved to: /opt/pr-agent-server/webhook_secret.txt")
