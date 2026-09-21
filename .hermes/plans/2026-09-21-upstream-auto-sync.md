# Upstream Auto-Sync — Auto Pull + Merge for Fork Repos

Status: implemented in `scripts/pr-queue-worker.py` (2026-09-21).
User decisions: interval **1 hour**, sync PRs **do** get the Claude Code auto-fix.

## Goal
For every repo the GitHub App is installed on whose GitHub metadata says
`fork: true`, pull the commits the upstream (parent) repo has that the fork lacks
and MERGE them into the fork's default branch — with conflict resolution, CI
verification and deduped notifications. No new cron/service: the existing
`pr-queue-worker.py` tick (every 5 min) runs it, gated by a per-repo interval.

## Fork state at build time (live)
| Fork | Parent | To merge | Fork divergence |
|---|---|---|---|
| `asepharyana/shiro-neko` | `zakirkun/shiro-neko` | 4 | 26 |
| `asepharyana/hermes-agent-mission-control` | `sharbelxyz/hermes-agent-mission-control` | 0 | 8 |

Both default branches are unprotected; the real shiro-neko merge conflicts in 14
files (`src/tools.ts`, `src/ui/App.tsx`, `src/tests…`).

## Design decisions (with reasons)
1. **Merge, never rebase** — preserves fork history/divergence (skill
   `fork-upstream-sync`).
2. **Inside `pr-queue-worker.py`** — the worker already owns the atomic cron
   lock, installation tokens and Discord plumbing; the sync is STEP 0 of the same
   tick, bounded to `max_per_tick = 2` forks, oldest-attempt-first so the budget
   rotates fairly.
3. **1h interval per repo** — the compare API is checked every tick (cheap), a
   merge attempt only when the interval elapsed AND the upstream tip changed
   (`last_attempt_sha`), so a failed/skipped sync is not retried every 5 minutes.
4. **Conflicted merges go to Claude Code** — `resolve_conflicts: true`. The
   prompt encodes the `fork-upstream-sync` rules (merge hunks by hand, never
   wholesale `--ours/--theirs`, strip UTF-8 BOM, run the repo's typecheck+tests
   before committing) plus the `merge-reconciler` impartiality contract (classify
   every hunk: disjoint-intent / same-question-different-answer / superseded;
   change nothing outside conflict markers; report every decision).
   Claude never pushes — the harness pushes.
5. **Clean merges get a quality pass** — `ai_fix_after_merge: true` runs one
   Claude Code pass over the merged files and commits
   `fix: auto-fix code quality [skip ci]`. On the PR path the normal worker AI
   fix applies (user decision), so sync PRs are treated like any other PR.
6. **Push path: owner PAT first, App token second** — the App has
   `contents:write` but NOT `workflows:write`, and the shiro-neko merge touches
   `.github/workflows/*`, so an App-token push is rejected. Clones use the App
   token; pushes use the gh CLI PAT (`_fetch_gh_token()`).
7. **Protected branch → PR path** — App tokens get 403 (not 404) on the
   branch-protection endpoint, so protection is detected from the PUSH result
   (GH006 / "protected branch" / required-status-check markers) and falls back to
   pushing a `upstream-sync-<ts>` branch + opening a PR that the normal pipeline
   finishes. Duplicate PRs are avoided by scanning open PRs for that head prefix.
8. **CI verify with sha-guarded auto-revert** — `verify_ci: true`. After a direct
   push, later ticks check the fork's CI at our merge sha; if it is still the tip
   and CI failed, the branch is force-pushed back to `pre_merge_sha` and Discord
   is notified. Never reverts when a human pushed on top; never applies to the
   protected/PR path; watch stops after `verify_ci_max_age_h = 6h`.
9. **Discord**: sync events go to the same `pr-agent-ops` webhook as the run
   reports (synced / PR opened / reverted / skipped-once).
10. **`merge_pr` PAT fallback** — a PR merge that changes workflow files is also
    a workflow-file push, so a 403 on the App merge retries with the PAT.

## Scope
- `scripts/pr-queue-worker.py` — new `# Upstream Fork Auto-Sync` section (config,
  discovery, compare, merge, conflict-resolve, push, PR path, verify/revert,
  orchestrator) + STEP 0 in `main()` + CLI flags.
- `scripts/test_pr_queue_sync.py` — new: 46 assertions over the orchestration.
- State: `/tmp/pr-queue-sync-state.json`; workdirs `/tmp/pr-queue-sync-work/`.
- No changes to `server/` (Bun), systemd units or the cron list.

## State shape
```json
{"owner/fork": {
  "last_sync_ts": 0, "last_attempt_sha": "", "last_merged_upstream_sha": "",
  "skip_reason": "", "notified": false,
  "pending_verify": {"sha": "", "pre_merge_sha": "", "branch": "main", "pushed_at": 0}
}}
```

## CLI (manual/dev)
```bash
python3 scripts/pr-queue-worker.py --sync-status
python3 scripts/pr-queue-worker.py --sync-only asepharyana/shiro-neko --dry
python3 scripts/pr-queue-worker.py --sync-only asepharyana/shiro-neko
```
`--dry` runs the whole flow (clone, merge, Claude conflict resolution) and stops
before pushing, leaving the prepared workdir in `/tmp/pr-queue-sync-work/<repo>`.

## Verification
- `python3 -m py_compile` clean.
- `python3 scripts/test_pr_queue_sync.py` → 46/46 (gating, clean merge, conflict
  resolution, failed resolution skip+dedupe, protected→PR, CI green/red/foreign-
  commit/running, fork discovery, push-error classification, config override).
- Live dry run against the real fork: clone + upstream fetch + conflicted merge +
  Claude Code resolution, verified with the repo's own `bun run typecheck`/`bun test`.
- Live production: the 5-minute cron picks it up on the next tick after the push
  (the cron wrapper ff-only pulls this repo and execs the repo copy).
- Regression guard for the bug the dry run caught: compare head ref must be
  `{owner}:{branch}` — a full `owner/repo:branch` head 404s.

## Out of scope
- Syncing non-default branches; pushing fork→upstream; scheduled rebase option.