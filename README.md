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
- Bun 1.3.14+ (runtime + build)
- GitHub App credentials (App ID, private key, webhook secret)
- 9router/OpenAI-compatible key for the LLM

### Local testing

```bash
cd server
bun install
bunx tsc --noEmit          # typecheck
bun test                   # unit tests (16 tests)
bun src/cli.ts --tool review --repo <owner>/<repo> --pr <n> --no-publish
```

### Run server (after setting up secrets)

```bash
# Secrets are resolved at startup: PR_AGENT_APP_ID, private key path,
# omniroute key file (see src/config.ts + src/secrets.ts)
cd server
bun src/index.ts           # starts on PORT (default 4023)
```

### Test tools end-to-end (real GitHub + LLM)

```bash
bun e2e.ts --repo asepharyana/nextjs-template --pr 19 --publish
bun src/cli.ts --tool describe --repo <owner>/<repo> --pr <n>
bun src/cli.ts --tool improve  --repo <owner>/<repo> --pr <n>
```

## Deployment

Deploy is fully automated via GitHub Actions on push to `main`:

```yaml
# .github/workflows/deploy.yml
1. build-and-deploy → bun install → typecheck → tests → bun build --compile
   → scp binary to VPS → swap /opt/pr-agent-server/bin/pr-agent-bun
   → restart pr-agent-bun.service → health check on :4023
2. cleanup → nix-gc-vps.sh (cleans legacy Nix store entries)
```

The production server is a single compiled binary
(`/opt/pr-agent-server/bin/pr-agent-bun`) running as a systemd service
(`pr-agent-bun.service`, port 4023, secrets via `bws-exec pr-agent`).

Secrets required in GitHub Actions:
- `VPS_HOST` — VPS IP address
- `VPS_USER` — SSH user
- `SSH_PRIVATE_KEY` — SSH private key for deploy user
- `GITEA_TOKEN` — for Gitea mirror (if using mirror workflow)

## Ops

- **Health watchdog**: cron `pr-agent-health-watchdog` (every 10 min) → `~/.hermes/scripts/pr-agent-health-check.sh` → curl `http://127.0.0.1:4023/health`
- **Secrets**: systemd `ExecStart=/usr/local/bin/bws-exec pr-agent env PORT=4023 /opt/pr-agent-server/bin/pr-agent-bun`
- **Prometheus**: `GET /api/metrics` → `pr_agent_requests_total`, `pr_agent_model_failures`
- **Analytics**: `GET /api/analytics` → JSON summary (legacy `pr-agent.*.log` + `pr-agent.bun.jsonl`)
- **Discord**: `POST /api/v1/notify_review` → pr-agent-ops webhook

## Legacy (Python/Nix — retired 2026-09-21)

The original Python `pr_agent` server (FastAPI + Nix build, port 4002) is fully
retired: systemd unit deleted, venv removed, `src/*.py` + `scripts/setup_*` +
flake removed from the repo. The Bun binary replaced it end-to-end.

## License

MIT — see [LICENSE](LICENSE) if present at deploy.
