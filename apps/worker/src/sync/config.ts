/**
 * Sync configuration + the sync-state accessors — port of
 * `scripts/pr-queue-worker.py` lines 992-1004 (`UPSTREAM_SYNC`),
 * 1029-1033 (`sync_config`) and 1025-1026 (`_sync_entry`).
 *
 * THE STATE FILE IS NOT HERE, and that is deliberate. `load_sync_state` /
 * `save_sync_state` live in `apps/worker/src/state.ts` already, and `/tmp/
 * pr-queue-sync-state.json` survives the Python→TS cut-over: whatever this
 * module writes must stay parseable by the Python reader. This file therefore
 * only adds the TYPED view of an entry on top of that opaque
 * `Record<string, Record<string, unknown>>`, and never touches a file.
 *
 * TWO RULES THE PYTHON ENCODED IN ITS SHAPE, KEPT HERE:
 *
 * 1. `repos` IS NOT PART OF A RESOLVED CONFIG. `sync_config` builds the
 *    worker-wide dict from every key EXCEPT `repos`, then overlays the
 *    per-repo override (lines 1031-1032). Copying the map in would leak a
 *    whole sub-tree into a per-repo config and, worse, make the override
 *    self-referential. `RepoOverride` is therefore `Partial<SyncConfig>`
 *    minus `repos` — the key is not even typeable in an override.
 * 2. THE PER-REPO MAP IS INJECTED, NEVER IMPORTED. The Python reads a module
 *    global; reading `process.env` or a singleton here would make the override
 *    group untestable and would freeze the value at import time — and Bun
 *    snapshots `homedir()`/env at process start, which is how an earlier suite
 *    passed only on the machine holding the real value.
 */

/**
 * One fork's resolved sync config. Every field has the Python's default from
 * lines 994-1003; a per-repo override may replace any of them.
 */
export interface SyncConfig {
	/** `cfg.get("enabled", True)` — a per-repo opt-out (line 1750). */
	enabled: boolean
	/** Hours between upstream comparisons for this fork (line 994). */
	interval_h: number
	/** Forks attempted per 5-minute tick (line 995). */
	max_per_tick: number
	/** Hand a conflicted merge to the agent (line 996). */
	resolve_conflicts: boolean
	/** Quality pass on a clean merge (line 997). */
	ai_fix_after_merge: boolean
	/** Revert our own merge commit if fork CI fails (line 998). */
	verify_ci: boolean
	/** Stop watching (KEEPING the merge) after this many hours (line 999). */
	verify_ci_max_age_h: number
	/** Wait this long before concluding "this repo has no CI" (line 1000). */
	no_ci_grace_s: number
	/** Pin the local/upstream branch pair instead of deriving it (line 1003). */
	branches?: { local?: string; upstream?: string }
}

/**
 * A per-repo override. `repos` cannot appear here — see the note above — and
 * `max_per_tick` is worker-wide (the Python reads it from `UPSTREAM_SYNC`, not
 * from the resolved config, at line 1747), so it is excluded to keep a single
 * budget per tick rather than one per fork.
 */
export type RepoOverride = Partial<Omit<SyncConfig, "repos" | "max_per_tick">>

/** Per-repo overrides, keyed by `owner/fork`. */
export type RepoOverrides = Record<string, RepoOverride>

/**
 * The worker-wide defaults, transcribed from Python lines 994-1003.
 *
 * `enabled` is deliberately ABSENT: Python computes it at line 993 from
 * `PR_AGENT_UPSTREAM_SYNC != "0"`, and that read must happen at CALL time
 * (see `upstreamSyncEnabled`) because a module-scope env read froze the value
 * at import. `runUpstreamSync` merges it in when it resolves a config.
 */
export const UPSTREAM_SYNC_DEFAULTS: SyncConfig = {
	enabled: true,
	interval_h: 1.0,
	max_per_tick: 2,
	resolve_conflicts: true,
	ai_fix_after_merge: true,
	verify_ci: true,
	verify_ci_max_age_h: 6.0,
	no_ci_grace_s: 600,
}

// ── Sync state ───────────────────────────────────────────────────────────────

/**
 * The on-disk sync state, kept in state.ts's exact shape so the two
 * serializers stay interchangeable across the cut-over.
 */
export type SyncState = Record<string, Record<string, unknown>>

/** `pending_verify` as written by a successful push (Python lines 1647-1650). */
export interface PendingVerify {
	/** The merge commit we pushed. */
	sha: string
	/** The fork's tip before the merge — the revert target. */
	pre_merge_sha: string
	branch: string
	/** Unix seconds, from `time.time()`. */
	pushed_at: number
}

/**
 * The per-fork entry, typed. `pending_verify` is `null` (not absent) once a
 * watch finishes — Python assigns `entry["pending_verify"] = None` on every
 * terminal path (lines 1467, 1473, 1481, 1499, 1506, 1513) and the file
 * carries that null through the cut-over.
 */
export interface SyncEntry extends Record<string, unknown> {
	last_sync_ts?: number
	last_attempt_sha?: string
	last_merged_upstream_sha?: string
	skip_reason?: string
	notified?: boolean
	pending_verify?: PendingVerify | null
}

/**
 * Python `_sync_entry(state, repo_full)` (line 1026) — `setdefault`, so the
 * entry is CREATED if absent. The caller relies on that: `run_upstream_sync`
 * sorts on the entry it materialises (line 1746) and the fake sync in the
 * Python tests writes through the same accessor.
 */
export function syncEntry(state: SyncState, repo: string): SyncEntry {
	if (state[repo] === undefined) state[repo] = {}
	return state[repo] as SyncEntry
}

/**
 * The `pending_verify` block, or undefined when there is no watch.
 *
 * Python's `entry.get("pending_verify") or {}` then `.get("sha")` (lines
 * 1458-1459) means a null, a missing key and a `{}` are all "no watch"; this
 * returns undefined for all three, and the caller guards on `sha` being
 * truthy — the same predicate.
 */
export function pendingVerify(
	entry: Record<string, unknown> | undefined,
): PendingVerify | undefined {
	const pending = entry?.pending_verify
	if (pending === null || pending === undefined || typeof pending !== "object") return undefined
	return pending as PendingVerify
}

/**
 * `float(entry.get("last_sync_ts") or 0)` (lines 746, 1773).
 *
 * `0` for a missing, null, non-numeric or falsy value: an unparsable
 * timestamp must read as "never synced", which makes the interval gate pass
 * rather than wedge a fork forever.
 */
export function num(value: unknown): number {
	const n = Number(value)
	return Number.isFinite(n) ? n : 0
}

// ── Config resolution ────────────────────────────────────────────────────────

/**
 * Python `sync_config(repo_full)` (lines 1029-1033): "Worker-wide sync
 * defaults merged with the per-repo override."
 *
 * `enabled` is a parameter rather than a property of the defaults because the
 * Python folds the env read into `UPSTREAM_SYNC["enabled"]` at import; passing
 * it keeps that read at CALL time (see `upstreamSyncEnabled`) and makes the
 * disable switch testable without touching `process.env`.
 */
export function syncConfig(
	repo: string,
	overrides: RepoOverrides = {},
	enabled = UPSTREAM_SYNC_DEFAULTS.enabled,
): SyncConfig {
	const override = overrides[repo] ?? {}
	return { ...UPSTREAM_SYNC_DEFAULTS, ...override, enabled: override.enabled ?? enabled }
}

/**
 * Python line 993: `os.environ.get("PR_AGENT_UPSTREAM_SYNC", "1") != "0"`.
 *
 * READ AT CALL TIME from an injected env, never at module scope. The env is a
 * parameter so a test can drive both branches without mutating
 * `process.env`, and so the production wiring reads the real `process.env`
 * at the moment the tick runs.
 */
export function upstreamSyncEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.PR_AGENT_UPSTREAM_SYNC !== "0"
}

/**
 * `PR_AGENT_SYNC_SKIP_REPOS` — the operator's per-fork opt-out, resolved into
 * the `enabled: false` override `syncConfig` already honours (Python line 1750).
 *
 * WHY THIS EXISTS: a fork whose local divergence is so large that every merge
 * needs dozens of agent-resolved conflicts is not a sync candidate. The Python
 * had no switch for it — an operator edited `UPSTREAM_SYNC["repos"]` in the
 * source — and without one the only options here were "burn an hour of agent
 * time per tick" or disable upstream sync for the whole installation.
 *
 * A COMMA-SEPARATED LIST, not JSON: the value lives in a systemd `Environment=`
 * line, where a JSON blob needs quoting that a shell-less unit file gets wrong
 * silently. A blank entry is dropped rather than becoming a repo named `""`.
 *
 * Read at CALL time from an injected env, exactly like `upstreamSyncEnabled`, so
 * a test can drive it without mutating `process.env`.
 */
export function skipRepoOverrides(
	env: Record<string, string | undefined> = process.env,
): RepoOverrides {
	const overrides: RepoOverrides = {}
	for (const raw of (env.PR_AGENT_SYNC_SKIP_REPOS ?? "").split(",")) {
		const repo = raw.trim()
		if (repo) overrides[repo] = { enabled: false }
	}
	return overrides
}
