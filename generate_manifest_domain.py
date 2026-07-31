#!/usr/bin/env python3
"""Generate GitHub App manifest with domain URL"""
import json
import base64
import secrets

webhook_secret = secrets.token_hex(20)
print(f"Webhook Secret: {webhook_secret}")

manifest = {
    "name": "pr-agent-auto-review",
    "url": "https://github.com/asepharyana",
    "hook_attributes": {
        "url": "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks",
        "active": True
    },
    "redirect_url": "https://pr-agent.asepharyana.my.id/setup/callback",
    "callback_urls": ["https://pr-agent.asepharyana.my.id/setup/callback"],
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

manifest_json = json.dumps(manifest)
manifest_b64 = base64.urlsafe_b64encode(manifest_json.encode()).decode()

print(f"\n{'='*60}")
print("BUAT APP BARU - Klik link ini di browser GitHub:")
print(f"{'='*60}")
print(f"https://github.com/settings/apps/new?manifest={manifest_b64}")
print(f"{'='*60}")

# Save
with open("/opt/pr-agent-server/manifest_domain.json", "w") as f:
    json.dump(manifest, f, indent=2)
with open("/opt/pr-agent-server/webhook_secret.txt", "w") as f:
    f.write(webhook_secret)

print(f"\nWebhook secret: {webhook_secret}")
print(f"Webhook URL: https://pr-agent.asepharyana.my.id/api/v1/github_webhooks")
