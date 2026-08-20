# PR-Agent Server

Nix-deployed GitHub App server for **automated PR review + auto-merge** using a custom LLM endpoint (9router/Omniroute).

## Architecture

```
GitHub webhook → Caddy (reverse proxy, :4002)
    → pr-agent-server (Nix profile, uvicorn on :4002)
        → PR-Agent github_app.py (FastAPI)
            → 9router API (custom OpenAI-compatible endpoint)
```

## Project Layout

```
pr-agent-server/
├── src/                    # Main application modules
│   ├── run_server.py       # FastAPI server + analytics/metrics + Discord webhook
│   ├── auto_merge_bot.py   # Periodic PR review→approve→merge bot
│   ├── trivial_merge.py    # Trivial PR fast-path (docs/dependabot/tiny diffs)
│   ├── health-check.py     # Model health watchdog (tests primary + fallbacks)
│   ├── sync-key.py         # Auto-syncs BWS router key to disk on service start
│   ├── callback_server.py  # Dev callback server for GitHub App manifest
│   ├── start_server.py     # Legacy server start script
│   └── config/             # Runtime config (gitignored at deploy time)
├── scripts/                # Setup and deployment helpers
│   ├── setup_all.py        # Full setup: manifest + config + systemd service
│   ├── setup_app.py        # App-specific setup
│   ├── generate_manifest.py  # GitHub App manifest URL generator
│   └── generate_manifest_domain.py
├── templates/
│   └── manifest.json       # GitHub App manifest template
├── .github/workflows/
│   ├── deploy.yml          # CI: syntax → build → deploy → GC
│   ├── flakehub-publish-rolling.yaml
│   └── mirror-gitea.yml
├── flake.nix               # Nix build (creates venv + binary wrappers)
├── flake.lock              # Pinned Nix dependencies
├── .editorconfig           # Editor formatting rules
├── .gitignore
└── README.md
```

## Development

### Prerequisites
- Nix (for builds)
- Python 3.12+
- GitHub App credentials (App ID, private key, webhook secret)
- BWS (Bitwarden Secrets Manager) access token

### Local testing

```bash
# Syntax check
python3 -m py_compile src/run_server.py src/auto_merge_bot.py src/health-check.py src/sync-key.py src/trivial_merge.py src/callback_server.py

# Nix build
nix build .#default

# Run server (after setting up secrets)
export BWS_ACCESS_TOKEN="<your-bws-token>"
nix run .#pr-agent-server-sync-key  # syncs the router key
nix run .#pr-agent-server            # starts uvicorn on :3000

# Health check
nix run .#pr-agent-server-health-check
```

## Deployment

Deploy is fully automated via GitHub Actions on push to `main`:

```yaml
# .github/workflows/deploy.yml
1. syntax-check  → python3 py_compile all modules
2. build-and-deploy → nix build → SSH to VPS → update profile → restart service
3. cleanup → nix-gc-vps.sh (with profile link repair)
```

Secrets required in GitHub Actions:
- `VPS_HOST` — VPS IP address
- `VPS_USER` — SSH user
- `SSH_PRIVATE_KEY` — SSH private key for deploy user
- `GITEA_TOKEN` — for Gitea mirror (if using mirror workflow)

## Ops

- **Health watchdog**: cron `pr-agent-health-watchdog` (every 10 min) → `~/.hermes/scripts/pr-agent-health-check.sh` → Nix binary `pr-agent-health-check`
- **Key auto-sync**: systemd `ExecStartPre=/usr/local/bin/bws-exec pr-agent -- <profile>/bin/pr-agent-sync-key`
- **Prometheus**: `GET /api/metrics` → `pr_agent_requests_total`, `pr_agent_model_failures`
- **Analytics**: `GET /api/analytics` → JSON summary (unwrap `"record"` field)
- **Discord**: `POST /api/v1/notify_review` → pr-agent-ops webhook

## Nix Profile Integrity

⚠️ See the `devops/pr-agent-deployment` skill for troubleshooting broken `-link` profile symlinks after `nix store gc`. The GC script (`/usr/local/bin/nix-gc-vps.sh`) now includes a repair step.

## License

MIT — see [LICENSE](LICENSE) if present at deploy.
