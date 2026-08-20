# PR-Agent Server

Nix-deployed GitHub App server for automated PR review + auto-merge, using a custom LLM endpoint (9router/Omniroute).

## Architecture

```
GitHub webhook → Cloudflare DNS → Caddy (reverse proxy, :4002)
    → pr-agent-server (Nix profile, uvicorn)
        → PR-Agent github_app.py (FastAPI)
            → 9router API (custom OpenAI-compatible endpoint)
```

## Components

| File | Purpose |
|------|---------|
| `run_server.py` | Main FastAPI server — GitHub App webhook handler + analytics/metrics + Discord notifications |
| `auto_merge_bot.py` | Periodic bot that finds reviewed PRs and merges them |
| `trivial_merge.py` | Trivial PR fast-path (docs-only, dependabot, <100 lines) |
| `health-check.py` | Model health watchdog — tests primary + fallback models against 9router |
| `sync-key.py` | Auto-syncs the BWS router key to disk on every service start |
| `generate_manifest.py` | Creates GitHub App manifest URL |
| `callback_server.py` | Dev callback server for receiving GitHub App credentials |
| `flake.nix` | Nix build definition — produces the deployable package |

## Development

```bash
# Syntax check all Python files
python3 -m py_compile run_server.py auto_merge_bot.py health-check.py sync-key.py trivial_merge.py callback_server.py generate_manifest.py setup_all.py setup_app.py start_server.py

# Build with Nix
nix build .#default

# Deploy (CI does this automatically on push to main)
nix copy --to ssh://user@vps $STORE_PATH
ssh user@vps "sudo /nix/var/nix/profiles/default/bin/nix-env --profile /nix/var/nix/profiles/pr-agent-server --set '$STORE_PATH'"
ssh user@vps "sudo systemctl restart pr-agent-server"
```

## Ops

- **Health watchdog**: cron `pr-agent-health-watchdog` (every 10m) → `~/.hermes/scripts/pr-agent-health-check.sh`
- **Key sync**: systemd `ExecStartPre` → `pr-agent-sync-key` (BWS → disk)
- **Prometheus**: `GET /api/metrics` → `pr_agent_requests_total`, `pr_agent_requests_by_command`, `pr_agent_model_failures`
- **Analytics**: `GET /api/analytics` → JSON summary of recent events + failures
- **Discord**: `POST /api/v1/notify_review` → webhook delivery for review complete/failed

## Nix Profile Integrity

After deploy, run `nix-gc-vps.sh` to clean up old generations. The GC script now includes
a repair step that fixes broken profile symlinks before running `nix store gc`, preventing
the issue where profile `-link` dirs get deleted and store paths become unreferenced (see
`devops/pr-agent-deployment` skill for full troubleshooting).
