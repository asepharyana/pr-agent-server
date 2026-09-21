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
5. **Safety analysis** → parses the review body for security/major-issue
   blockers; score must be ≥ 6/10
6. **CI gate** → waits for the required check to pass (closes stale dependabot
   PRs stuck failing CI for > `STALE_CI_CLOSE_DAYS`)
7. **Approve + merge**

## Upstream Fork Auto-Sync

Since 2026-09-21 the same 5-minute tick also syncs every repo in the App
installation whose GitHub metadata says `fork: true`: new upstream (parent)
commits are **merged** (never rebased) into the fork's default branch, gated by
a per-repo interval (default **1 hour**; `UPSTREAM_SYNC` config block).

- **Conflicted merge** → Claude Code resolves it (merge-reconciler rules: merge
  hunks by hand, never wholesale `--ours/--theirs`, run the repo's own
  typecheck/tests before committing). Claude never pushes — the harness does.
- **Clean merge** → one Claude Code quality pass over the merged files,
  committed as `fix: auto-fix code quality [skip ci]`.
- **Protected default branch** → detect from the push result (GH006 /
  required-status-check) and fall back to opening an `upstream-sync-*` PR that
  the normal pipeline (review → AI fix → CI → approve → merge) finishes.
- **CI safety** → after a direct push the worker verifies the fork's CI at our
  merge commit; a red CI at OUR merge sha (still the tip, no human commits on
  top) force-reverts to the pre-merge sha. Watch stops after 6 h.
- **Push credentials** → owner PAT (gh CLI) first because the App lacks
  `workflows:write`; App token is the fallback. Clones use the App token.
- **State** → `/tmp/pr-queue-sync-state.json` (skip/interval/pending-verify),
  workdirs `/tmp/pr-queue-sync-work/`.
- **Notifications** → same `pr-agent-ops` Discord webhook: synced, PR opened,
  reverted, skipped-once.

Manual/dev:
```bash
python3 scripts/pr-queue-worker.py --sync-status
python3 scripts/pr-queue-worker.py --sync-only asepharyana/shiro-neko --dry   # stops before push
python3 scripts/pr-queue-worker.py --sync-only asepharyana/shiro-neko
```
Tests: `python3 scripts/test_pr_queue_sync.py` (46 assertions; no network —
gh_api/git/Claude/push are monkeypatched).

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