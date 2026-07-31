#!/usr/bin/env python3
"""PR-Agent GitHub Webhook Server - Start Script"""
import os
import sys

# Add the pr-agent package to path
sys.path.insert(0, os.path.expanduser("~/hermes-agent/.venv/lib/python3.12/site-packages"))

from pr_agent.servers.github_app import app
import uvicorn

if __name__ == '__main__':
    port = int(os.environ.get("PORT", "3000"))
    print(f"Starting PR-Agent GitHub App server on 0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
