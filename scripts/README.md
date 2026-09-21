# PR Queue Worker

`pr-queue-worker.py` — the orchestration cron that watches open PRs across all
repos where the PR-Agent GitHub App is installed and drives the full lifecycle:

1. **Open PR found** → ensure a PR-Agent review exists (fabricates a webhook to
   `pr-agent.asepharyana.my.id` if not)
2. **Toolchain pin guard** → closes dependabot PRs that bump pinned toolchain
   majors (see `TOOLCHAIN_PINS` map — typescript/eslint/@tsparticles/…) instead
   of waiting on them forever
3. **AI auto-fix** → runs Claude Code (`-p`) on the PR head for up to
   `AI_FIX_MAX_TURNS` turns, then pushes the fix
4. **Safety analysis** → parses the review body for security/major-issue
   blockers; score must be ≥ 6/10
5. **CI gate** → waits for the required check to pass (closes stale dependabot
   PRs stuck failing CI for > `STALE_CI_CLOSE_DAYS`)
6. **Approve + merge**

## Deployment

- **Cron**: Hermes cron job `04f13b9fdadc`, every 5 minutes
- **Live path**: `~/.hermes/scripts/pr-queue-worker.py` (cron reads this file —
  keep it in sync with this repo copy)
- **Secrets**: NOT in this file. Hydrated at import from `~/.hermes/.env` (
  `PR_AGENT_APP_ID`, `PR_AGENT_KEY_PATH`, `PR_AGENT_WEBHOOK_SECRET`,
  `PR_AGENT_WEBHOOK_URL`). The GitHub App private key lives at
  `~/.hermes/keys/pr-agent-key.pem` (gitignored, never commit).

## Sync note

This repo is the canonical version. The live cron copy under `~/.hermes/scripts/`
is what actually runs — after editing here, `cp scripts/pr-queue-worker.py
~/.hermes/scripts/pr-queue-worker.py` and verify with:

```bash
/home/code/hermes-agent/.venv/bin/python3 -m py_compile ~/.hermes/scripts/pr-queue-worker.py
timeout 90 /home/code/hermes-agent/.venv/bin/python3 ~/.hermes/scripts/pr-queue-worker.py
```