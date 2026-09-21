# Queue Worker Resiliency — Skip on Error + Conflict Auto-fix + Deduped Notify

## Goal
Make pr-queue-worker.py resilient: no infinite looping on infra errors,
auto-resolve merge conflicts via Claude Code, and notify Discord about skips
exactly once (no repeated spam).

## Scope
- `scripts/pr-queue-worker.py` only (cron worker, canonical in repo)
- State persisted in `/tmp/pr-queue-fix-state.json` (already exists)

## Changes

### A. Skip-on-error (no loop) — fix-state gains skip reasons
Current `FIX_STATE_FILE` shape: `{repo: {pr: head_sha}}` (fixed map).
Extend value to either a string SHA (fixed) or a dict for skip:
  `{repo: {pr: {"fixed_sha": "<sha>", "skip_reason": "<reason>", "skip_sha": "<sha>"}}}`
- `run_ai_fix` failure kinds:
  - CLI not found / not executable → **infra error** → mark skipped, notify once
  - timeout → mark skipped (Claude hung), notify once
  - "Claude ran but no push" → NOT infra error (Claude worked, nothing to fix)
    → allow retry next tick (cheap) OR mark fixed? — decide: keep retry (this
    is often a transient "no changes needed" state, but re-running every tick
    is exactly the loop user complains about) → **mark skipped too** (reason
    "no changes produced"), notify once, so it stops looping. User can re-open.
  - clone failed → transient (network) → retry next tick (NOT skip) — but cap:
    track clone-fail attempts, after 3 → skip w/ notify.
- `already_fixed` semantics: returns True also for skip state (same SHA) so we
  don't re-run OR re-notify.
- New helper `mark_skip(state, repo, pr, sha, reason)` + `get_skip(state,...)`.

### B. Merge conflict → Claude Code resolve
- When `mergeable is False` (GitHub says conflict) OR merge returns 409:
  - If not already attempted at this SHA (fix-state): run `run_ai_fix` (its
    prompt already includes "merge base + resolve conflicts intelligently").
  - If fix returns True → continue to re-check mergeability next iteration
    (head SHA changed; loop naturally proceeds).
  - If fix returns False (error/no push) → mark skip + notify once.
- Prevent infinite conflict-fix loop: one AI attempt per head SHA (fix-state
  `fixed_sha` covers it). If Claude pushes but conflict persists → next tick
  `mergeable is False` again but fix-state SHA = old → we'd re-run. Fix:
  mark conflict-resolve-attempted in state with the head SHA and the *result*
  ("conflict-fix-pushed" / "conflict-fix-failed"); skip re-run on same SHA.

### C. Deduped Discord notification for skips
- State file gains `notified: {repo: {pr: {"reason": sha}}}` (or embed in skip
  entry: when we notify, record sha; skip notify if same sha+reason already
  notified).
- Notification: one embed per skip reason, listing PRs:
  `⚠️ Skipped: #19 (dependabot) — Clode Code CLI not found` — only on first
  occurrence per PR+reason, not every 5-min tick.
- The full run report (flush_log) still goes out each tick — that's the
  periodic status, fine. The dedupe applies to *skip-specific* notifications.

## Files touched
- `scripts/pr-queue-worker.py`

## Verification
- Unit-ish: run worker with a fake PR? Hard (needs GitHub). Instead:
  - py_compile
  - dry-run logic test: monkeypatch run_ai_fix to return False with
    "Claude Code CLI not found" → assert mark_skip called once, second run
    skips re-attempt, notify once (check state file).
  - conflict path: monkeypatch mergeable False + run_ai_fix True → assert
    conflict-fix-attempt recorded once.
- Live: after deploy, open a tiny conflicting PR (or use an existing one) and
  watch one skip notification, then verify no repeat next tick.