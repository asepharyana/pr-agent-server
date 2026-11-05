/**
 * Fix-state / sync-state JSON — port of `scripts/pr-queue-worker.py`
 * lines 236-298 (fix state) and 1006-1022 (sync state).
 *
 * CUT-OVER CONTRACT (Task 17): these files survive the Python→TS switch, so the
 * on-disk format must stay parseable by the Python reader. Two files, two
 * different serializers — deliberately NOT unified:
 *   - fix state  → `JSON.stringify(state)`, compact, no indent (Python line 249)
 *   - sync state → `JSON.stringify(state, null, 1)`, indent=1 (Python line 1020)
 * Repo keys are full `owner/repo` names; PR keys are STRINGIFIED numbers.
 *
 * Note: JSON.parse/JSON.stringify omit the `": "` separator spaces Python's
 * `json.dumps` emits, so the fix-state bytes are not identical — they are
 * PARSE-equivalent, which is what the Python reader needs. The sync state
 * (indent=1) matches the live file byte-for-byte.
 *
 * SAVE SEMANTICS: the Python mutators (`mark_fixed`, `mark_skip`,
 * `mark_skip_notified`) persist as a side effect, so a caller that forgets to
 * save re-fixes the same PR every tick. Here each mutator takes an OPTIONAL
 * `file`: pass it and the write happens for you (Python parity); omit it and
 * the mutation stays in memory (which is what the unit tests do, so they
 * never touch the production state path). Prefer passing the file.
 */
import { readFileSync, writeFileSync } from "node:fs"

/** Python `FIX_STATE_FILE` (line 66) — the canonical path for `saveFixState`. */
export const FIX_STATE_FILE = "/tmp/pr-queue-fix-state.json"
/** Python `SYNC_STATE_FILE` (line 985). */
export const SYNC_STATE_FILE = "/tmp/pr-queue-sync-state.json"

/** Per-PR record. `skip_reason` is absent (not null) when there is no skip. */
export interface PrEntry {
	sha?: string
	skip_reason?: string
	notified?: boolean
	/**
	 * Consecutive failed attempts at `sha`, cleared by `markFixed`/`markSkip`.
	 *
	 * THE ATTEMPT TALLY. `skip_reason` only ever got set for `[INFRA]` failures
	 * (CLI missing, timeout, gateway down). An ORDINARY failure recorded nothing
	 * at all, so the next tick saw a PR with no state, concluded it was untried,
	 * and paid for the identical work again. GMW#109 sat that way for days:
	 * `🔴 SAFETY BLOCKED (score: 0/10)` every five minutes, and neither the block
	 * nor the "agent ran but no commit" line below it left a single byte behind.
	 *
	 * It is a DIAGNOSTIC, NOT A DEADLINE. An earlier version capped it with
	 * `MAX_ATTEMPTS` and pinned the PR past the cap, which was wrong — a PR that
	 * cannot be fixed must keep being retried, not be written off, and pinning it
	 * is a permanent stall rather than an escalation. Nothing reads this to
	 * decide whether to give up; it exists so the report can say "attempt 47" and
	 * so a human can see at a glance that a PR is stuck rather than merely slow.
	 *
	 * Counted from scratch whenever the head SHA moves, because a new head is
	 * new work and must not inherit the previous head's tally.
	 */
	attempts?: number
	/**
	 * The head the `attempts` tally belongs to. SEPARATE from `sha` on purpose:
	 * `sha` is what `alreadyFixed` reads as "fixed here", so keying the tally off
	 * it made a recorded failure indistinguishable from a recorded success and
	 * suppressed every retry. See `bumpAttempt`.
	 */
	attempt_sha?: string
	/**
	 * How many commits the recorded fix actually produced. 0 means "the agent
	 * ran and found nothing to improve", which is what `shouldRetryAiFix` keys on
	 * to tell that apart from "the agent's fix landed and still did not help".
	 */
	fix_commits?: number
	/**
	 * Agent runs at `budget_sha` that ENDED BY RUNNING OUT OF THEIR OWN BUDGET —
	 * `--max-turns` reached, or `AI_FIX_TIMEOUT` elapsed. Distinct from
	 * `attempts`, and the distinction is the whole point:
	 *
	 *   - `attempts` counts FAILURES of every kind and has no ceiling (see its
	 *     doc comment): a PR that cannot be fixed keeps being retried.
	 *   - this counts a specific, expensive EVENT — a run that burned its full
	 *     turn/time allowance without reaching a verdict. Each one costs up to
	 *     `AI_FIX_TIMEOUT` (1800s) of a paid model.
	 *
	 * WHY IT NEEDS ITS OWN CEILING. A timeout is not evidence that retrying is
	 * wrong (the model may just have been slow), so it must not be pinned — but
	 * it is also not free, and unbounded it becomes "1800s every five minutes,
	 * forever" on a PR whose blocker no agent can reach. Measured on
	 * hub#61 + pr-agent-server#27, both a `@moonrepo/cli@2.6.3` bump whose
	 * platform binaries were never published: there is no code change that makes
	 * those CI runs green, so every run was guaranteed to exhaust its budget.
	 *
	 * Past `AI_FIX_BUDGET_CEILING` the agent simply stops being offered at this
	 * head and the PR falls through to the ordinary CI gate — NOT a `skip_reason`,
	 * so the report stays truthful ("we spent the budget, it did not help") and a
	 * head that moves still releases everything.
	 */
	budget_runs?: number
	/** The head the `budget_runs` tally belongs to — separate from `sha` for the
	 *  same reason as `attempt_sha`. */
	budget_sha?: string
	/**
	 * How many times the SAFETY GATE has refused this head's review, and the head
	 * it was refused at.
	 *
	 * THE THIRD COUNTER, and it exists because this gate is the one failure that
	 * cannot be retried into a different answer. Every other arm here waits for
	 * something OUTSIDE the worker to change — CI going green, a head moving, a
	 * repo rule being relaxed — and `attempts` records that wait. The safety gate
	 * instead reads a value that is FIXED at this head: `stepReview` only fetches
	 * a new body when it finds NO review, so while a review exists the same bytes
	 * are scored every tick. `analyzeReviewSafety` is deterministic, so an
	 * identical body returns an identical verdict forever. Measured on
	 * mcpedia#48: both review bodies on the PR score `{safe:false, score:0}`,
	 * and nothing in the pipeline can ever post a third one.
	 *
	 * `attempts` alone therefore produced the exact loop this worker exists to
	 * prevent — the same `🔴 SAFETY BLOCKED (score: 0/10)` every five minutes,
	 * with a number climbing next to it that nothing acted on. A tally that only
	 * climbs is a log, not a rule; this one has a ceiling, and reaching it retires
	 * the PR (see `pr/safety-block.ts`) instead of paying for a fourth identical
	 * read.
	 *
	 * Keyed on `safety_block_sha` so a head that moves re-opens the question: a
	 * force-push or a fix commit buys a genuinely new review and a fresh count.
	 */
	safety_block_runs?: number
	safety_block_sha?: string
	/**
	 * The reason this bump was judged UNSHIPPABLE (see `pr/bump-guard.ts`), and
	 * the head it was judged at.
	 *
	 * Cached for cost, not for correctness: deciding it costs a registry read per
	 * platform binary the package declares (up to eight for `@moonrepo/cli`), and
	 * a five-minute tick would repeat that sweep forever on a PR nobody is going
	 * to fix. Keyed on `bad_bump_sha` so a new head re-opens the question — a
	 * force-push that moves the bump to a published version must be re-examined.
	 */
	bad_bump?: string
	bad_bump_sha?: string
	/**
	 * The head SHA a PR-Agent review was last REQUESTED for, and when (unix
	 * seconds) that request was made.
	 *
	 * WHY THIS EXISTS. Triggering a review returns HTTP 200 as soon as the
	 * request is ENQUEUED — `handle-webhook.ts` answers `{ok:true,triggered:true}`
	 * before a single token is generated. The worker treated that 200 as success
	 * and moved on, so when the review then died server-side (measured
	 * 2026-10-28: the LLM key was scoped to one model, and every review failed
	 * with a 403 on the fallback model) the report said
	 * "✅ PR-Agent triggered (HTTP 200)" on every tick for hours while not one
	 * review comment appeared. Nothing anywhere recorded that the review had been
	 * asked for and never arrived, so "waiting for the reviewer" and "the
	 * reviewer is broken" were indistinguishable from the queue's side.
	 *
	 * Recording the REQUEST (not the success) is what makes the two
	 * distinguishable: a PR with no review comment and no record is awaiting a
	 * first request, while one whose record is older than
	 * `REVIEW_PENDING_REPORT_TICKS` is a review that never landed — and the report
	 * says so instead of claiming a trigger succeeded.
	 *
	 * Keyed on the head SHA so a new commit re-opens the question: the new head
	 * genuinely needs a new review, whatever happened to the old one.
	 */
	review_sha?: string
	review_requested_at?: number
	/** How many times a review has been requested for `review_sha` without a
	 *  review comment ever appearing. Diagnostic, like `attempts`. */
	review_requests?: number
	[key: string]: unknown
}

/**
 * Record a failed attempt at `headSha` and return the running count.
 *
 * Idempotent per SHA: calling it for a different head resets to 1, because the
 * previous head's failures say nothing about this one. Only ever increments
 * when the SHA still matches, so a PR that moved does not inherit a stale
 * tally.
 *
 * NO CEILING. There is deliberately no maximum and no "give up" behaviour here
 * or anywhere that reads this number — see the `attempts` field's doc comment.
 *
 * WHY IT NO LONGER TOUCHES `entry.sha`. `bumpAttempt` used to set `sha` so the
 * tally would reset when the head moved. But `sha` is the SAME field
 * `alreadyFixed` reads as "the fix succeeded at this head", so recording a
 * failure silently marked the PR as DONE — `stepAiFix` then hit
 * `⏭️  Already fixed at this SHA` and the agent was never asked again. That is
 * the exact failure this worker exists to prevent, and it is unreachable to
 * notice from a report, because every line of it looks like success. The tally
 * is now keyed on its own `attempt_sha`, so a failed attempt stays a failed
 * attempt and only `markFixed` may claim a head.
 */
export function bumpAttempt(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	const prior = entry.attempt_sha === headSha ? Number(entry.attempts ?? 0) : 0
	const next = (Number.isFinite(prior) ? prior : 0) + 1
	entry.attempt_sha = headSha
	entry.attempts = next
	return next
}

/** The attempt count for `headSha`, or 0 if this head was never tried. */
export function attemptCount(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	// Keyed on `attempt_sha`, not `sha` — see `bumpAttempt`. Reading `sha` here
	// would count a SUCCESS as a tally of failures.
	if (entry.attempt_sha !== headSha) return 0
	const n = Number(entry.attempts ?? 0)
	return Number.isFinite(n) ? n : 0
}

/**
 * Record an agent run at `headSha` that exhausted its OWN budget (turn cap or
 * wall-clock timeout) and return the running count.
 *
 * Separate from `bumpAttempt` on purpose — see the `budget_runs` field. This one
 * has a ceiling and `attempts` deliberately does not.
 */
export function bumpBudgetRun(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	const prior = entry.budget_sha === headSha ? Number(entry.budget_runs ?? 0) : 0
	const next = (Number.isFinite(prior) ? prior : 0) + 1
	entry.budget_sha = headSha
	entry.budget_runs = next
	return next
}

/** How many budget-exhausting runs this head has already paid for. */
export function budgetRunCount(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	if (entry.budget_sha !== headSha) return 0
	const n = Number(entry.budget_runs ?? 0)
	return Number.isFinite(n) ? n : 0
}

/**
 * Record that the safety gate refused this head's review, and return the running
 * count for this head.
 *
 * Separate from `bumpAttempt` for the reason its field documents: `attempts` is
 * an unbounded diagnostic and this is a bounded rule. Sharing one number would
 * either give the diagnostic a ceiling it must not have, or leave the gate
 * uncapped — and the uncapped version is the five-minute loop on mcpedia#48.
 */
export function bumpSafetyBlock(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	const prior = entry.safety_block_sha === headSha ? Number(entry.safety_block_runs ?? 0) : 0
	const next = (Number.isFinite(prior) ? prior : 0) + 1
	entry.safety_block_sha = headSha
	entry.safety_block_runs = next
	return next
}

/** How many times the safety gate has already refused this head's review. */
export function safetyBlockCount(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	if (entry.safety_block_sha !== headSha) return 0
	const n = Number(entry.safety_block_runs ?? 0)
	return Number.isFinite(n) ? n : 0
}

/** The cached "unshippable bump" reason for this head, or undefined. */
export function badBumpReason(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): string | undefined {
	const entry = prEntry(state, repo, pr)
	if (entry.bad_bump_sha !== headSha) return undefined
	return typeof entry.bad_bump === "string" ? entry.bad_bump : undefined
}

/**
 * Remember that this head's bump is unshippable, so later ticks skip the
 * registry sweep. Pass `file` to persist, like every other mutator here.
 */
export function markBadBump(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
	reason: string,
	file?: string,
): PrEntry {
	const entry = prEntry(state, repo, pr)
	entry.bad_bump = reason
	entry.bad_bump_sha = headSha
	if (file !== undefined) saveFixState(file, state)
	return entry
}

/**
 * How many times a review has already been requested at `headSha` without one
 * ever appearing, or 0 when this head was never asked for.
 *
 * The tally is what lets the pipeline tell a FIRST request (which should be
 * reported as a normal trigger) from a REPEAT one on a review that never
 * landed — the case that used to print `✅ PR-Agent triggered (HTTP 200)`
 * indefinitely. Keyed on its own `review_sha` rather than `sha`, for the same
 * reason `bumpAttempt` keeps `attempt_sha`: `sha` means "the AI fix landed
 * here", and a review request is not a fix.
 */
export function reviewRequestCount(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	if (entry.review_sha !== headSha) return 0
	const n = Number(entry.review_requests ?? 0)
	return Number.isFinite(n) ? n : 0
}

/** When (unix seconds) a review was last requested at this head, or undefined. */
export function reviewRequestedAt(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number | undefined {
	const entry = prEntry(state, repo, pr)
	if (entry.review_sha !== headSha) return undefined
	const t = Number(entry.review_requested_at)
	return Number.isFinite(t) ? t : undefined
}

/**
 * Record that a review was requested at `headSha`, and return the running count
 * for this head. Call it only on an ACCEPTED request (2xx): a 403 or a socket
 * error means the review was never queued, and counting it would blame the
 * reviewer for a fault on our side.
 */
export function markReviewRequested(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
	nowSec: number,
	file?: string,
): number {
	const entry = prEntry(state, repo, pr)
	const prior = entry.review_sha === headSha ? Number(entry.review_requests ?? 0) : 0
	const next = (Number.isFinite(prior) ? prior : 0) + 1
	entry.review_sha = headSha
	entry.review_requested_at = nowSec
	entry.review_requests = next
	if (file !== undefined) saveFixState(file, state)
	return next
}

/** Drop the pending-review record: a review arrived, so nothing is owed. */
export function clearReviewRequest(state: FixState, repo: string, pr: number | string): void {
	const entry = prEntry(state, repo, pr)
	delete entry.review_sha
	delete entry.review_requested_at
	delete entry.review_requests
}

/** `{ "owner/repo": { "<pr>": PrEntry } }` */
export type FixState = Record<string, Record<string, PrEntry>>

/**
 * Sync bookkeeping per fork. The field set belongs to the sync task, which is
 * not ported yet, so the entry stays opaque rather than speculative.
 */
export type SyncState = Record<string, Record<string, unknown>>

/** Read a JSON file, falling back when it is missing, unreadable or corrupt. */
function readJsonTolerant<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T
	} catch {
		return fallback
	}
}

export function loadFixState(file: string = FIX_STATE_FILE): FixState {
	return readJsonTolerant<FixState>(file, {})
}

/**
 * Above this many open PRs, dead entries are worth clearing out.
 *
 * Sized to the FLEET, not to a round number. This worker watches 8 repos and a
 * typical tick sees 0–3 open PRs; the file held 36 entries on 2026-10-16, all of
 * them for closed or merged PRs. At the original 25 the prune would essentially
 * never have run, which makes it decoration rather than a guard.
 *
 * The threshold is a FLOOR ON SCAN QUALITY, not a statement about how busy the
 * queue is. `gatherOpenPrs` returns `[]` when `/app/installations` fails and
 * deliberately ignores the HTTP status (scan.ts), so a token problem, a rate
 * limit, or a GitHub outage all look exactly like "no open PRs". Pruning on a
 * short list is therefore how a state file gets destroyed. The only safe rule is
 * one that treats a suspiciously small scan as no information at all.
 *
 * Which means: on a quiet day — the common day — the prune simply does not run.
 * That is the intended trade. An overgrown file is a cosmetic problem; a wiped
 * one is an unrecoverable one.
 */
export const PRUNE_THRESHOLD = 5

/**
 * Drop fix-state entries for PRs that are no longer open.
 *
 * WHY. The file only ever grew. On 2026-10-16 it still held mcpedia #23–#28, every
 * one merged, including #28's `attempts: 99` — a number that reads as "currently
 * stuck" long after the PR closed. Nothing read those entries: `alreadyFixed` and
 * `getSkipReason` are keyed on repo + PR + SHA, and a closed PR never returns at
 * the same head, so they are dead weight that costs a human credibility every
 * time they open the file.
 *
 * DELIBERATELY CONSERVATIVE, in both directions:
 *
 *   - it only removes entries for PRs it can see are NOT open, so a wrong open-PR
 *     set can leave the file untouched but can never drop live state; and
 *   - it does nothing while `openPrs.size <= threshold`, so a transiently empty
 *     scan (a rate-limited API call returning `[]`) cannot wipe the file. An empty
 *     set is also ignored outright for the same reason.
 *
 * The worst case for this function is that it never runs. The worst case for
 * removing its guard would be a wiped state file, which is unrecoverable.
 *
 * @param openPrs `"repo/number"` keys the caller currently sees as open.
 */
export function pruneClosedFixState(
	state: FixState,
	openPrs: Set<string>,
	opts: { threshold?: number } = {},
): number {
	const threshold = opts.threshold ?? PRUNE_THRESHOLD
	// An empty set means "we do not know", not "nothing is open". Treating it as
	// the latter is precisely how a state file gets deleted by a bad API read.
	if (openPrs.size === 0 || openPrs.size <= threshold) return 0

	let removed = 0
	for (const [repo, prs] of Object.entries(state)) {
		for (const key of Object.keys(prs)) {
			if (!openPrs.has(`${repo}/${key}`)) {
				delete prs[key]
				removed += 1
			}
		}
		if (Object.keys(prs).length === 0) delete state[repo]
	}
	return removed
}

/** Compact, no indent — byte-compatible with Python's `json.dumps(state)`. */
export function saveFixState(file: string, state: FixState): void {
	writeFileSync(file, JSON.stringify(state))
}

export function loadSyncState(file: string = SYNC_STATE_FILE): SyncState {
	return readJsonTolerant<SyncState>(file, {})
}

/** indent=1, mirroring Python's `json.dumps(state, indent=1)`. OSError is swallowed. */
export function saveSyncState(file: string, state: SyncState): void {
	try {
		writeFileSync(file, JSON.stringify(state, null, 1))
	} catch {
		/* Python: `except OSError: pass` */
	}
}

/**
 * Get the per-PR entry, creating it if absent, and migrate the legacy format
 * `{repo: {pr: "sha"}}` (bare string) to the dict form IN PLACE. Python
 * `_pr_entry`, lines 251-259.
 */
export function prEntry(state: FixState, repo: string, pr: number | string): PrEntry {
	// Spelled as two statements rather than `?? (state[repo] = {})`: an
	// assignment nested in an expression reads as a typo at a glance.
	if (state[repo] === undefined) state[repo] = {}
	const repoState = state[repo] as Record<string, unknown>
	const key = String(pr)
	const existing = repoState[key]
	if (typeof existing === "string") {
		// legacy: {"pr": "sha"} → {"sha": "sha", "notified": false} (no skip_reason)
		repoState[key] = { sha: existing, notified: false }
	} else if (existing === undefined) {
		repoState[key] = {}
	}
	return repoState[key] as PrEntry
}

/** True when the PR was already fixed (or permanently skipped) at this SHA. */
export function alreadyFixed(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): boolean {
	return prEntry(state, repo, pr).sha === headSha
}

/**
 * Should the AI fix be OFFERED AGAIN even though this head was already recorded
 * as fixed?
 *
 * WHY. `alreadyFixed` is the right answer for a code PR: the agent's work landed,
 * and asking again just burns a 30-minute run to reach the same conclusion. It is
 * the WRONG answer when the recorded success did not unblock the PR — observed
 * live on mcpedia#28, where a vitest 5.0.3→5.0.4 dev-dep bump recorded a clean
 * tree (nothing to improve, honestly), was therefore marked fixed at that head,
 * and then sat on `⏭️  Already fixed at this SHA — skip AI fix` forever while CI
 * stayed red:
 *
 *   ⏭️  Already fixed at this SHA — skip AI fix
 *   🧪 CI: CI FAILED: moon check
 *   🔁 CI still red: CI FAILED: moon check (attempt 97 at this SHA)
 *
 * The recorded "fixed" was about the DIFF, and the blocker was somewhere the
 * agent never looks — CI configuration. So the agent is offered once more, but
 * only under conditions that keep it from becoming a 30-minute loop:
 *
 *   - the PR is a DEPENDABOT bump, because a human PR's author may be mid-push
 *     and re-running the agent over their shoulder is noise; and
 *   - the recorded work made no commit (`commits === 0`), because that is what
 *     distinguishes "the agent found nothing to improve" from "the agent's fix
 *     landed and still did not help". The second needs a human, not another
 *     identical run.
 *
 * @param commits how many commits the recorded fix actually produced.
 */
export function shouldRetryAiFix(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
	author: string,
): boolean {
	if (!alreadyFixed(state, repo, pr, headSha)) return false
	if (author !== "dependabot[bot]") return false
	return Number(prEntry(state, repo, pr).fix_commits ?? 0) === 0
}

/**
 * Mark the PR as fixed at `headSha`. Pass `file` to persist (Python parity).
 *
 * `commits` is how many commits the agent actually produced, and it is what
 * `shouldRetryAiFix` reads to tell "nothing to improve" (0) apart from "the fix
 * landed and still did not unblock this PR" (>0). Defaults to 0 so every existing
 * caller keeps its current behaviour.
 */
export function markFixed(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
	commits = 0,
	file?: string,
): PrEntry {
	const entry = prEntry(state, repo, pr)
	entry.sha = headSha
	entry.fix_commits = commits
	delete entry.skip_reason
	entry.notified = false
	// Success resets the tally: the next failure at this SHA starts from 1, not
	// from wherever a previous run left it. Without this a PR that fails once,
	// succeeds, then fails again would skip straight to escalation.
	delete entry.attempts
	delete entry.attempt_sha
	// The budget tally goes with it, for the same reason: a fix that landed is
	// not evidence about how many timeouts this head can still afford, and
	// carrying the count forward would make a later, unrelated timeout look like
	// the last one in a spent budget.
	delete entry.budget_runs
	delete entry.budget_sha
	// THE SAFETY TALLY IS DELIBERATELY *NOT* CLEARED HERE, and that is a
	// correction rather than an omission. `stepAiFix` runs BEFORE the safety
	// gate, so this function is called on the same tick the gate then refuses —
	// clearing the count here would reset it to 1 every tick and the ceiling
	// would be unreachable, which is the exact loop the ceiling exists to end.
	// It also is not needed: a fix that actually pushes moves the head, and the
	// tally is keyed on `safety_block_sha`, so a new head already reads 0. A fix
	// that pushes NOTHING (0 commits, the common dependabot outcome) leaves the
	// head — and therefore the review — untouched, so the count must stand.
	if (file !== undefined) saveFixState(file, state)
	return entry
}

/** The permanent skip reason for this PR+SHA, or undefined for any other SHA. */
export function getSkipReason(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): string | undefined {
	const entry = prEntry(state, repo, pr)
	return entry.sha === headSha ? entry.skip_reason : undefined
}

/** Permanently skip AI-fix/merge for this PR at this SHA. Pass `file` to persist. */
export function markSkip(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
	reason: string,
	file?: string,
): PrEntry {
	const entry = prEntry(state, repo, pr)
	entry.sha = headSha
	entry.skip_reason = reason
	// A skip RESOLVES the condition, so the tally goes with it. Leaving it
	// behind would mean that if the skip were ever cleared by hand, the very next
	// failure would escalate straight back to a pin with no fresh attempts.
	delete entry.attempts
	delete entry.attempt_sha
	// The safety tally is deliberately KEPT here. `markSkip` is what the gate
	// writes once it gives up, so erasing the count that justified giving up
	// would leave the state file unable to say why the PR was retired — and
	// `getSkipReason` is what stops the next tick from re-reading the same
	// review, so nothing loops either way.
	if (file !== undefined) saveFixState(file, state)
	return entry
}

/** True if the skip notification for this PR+SHA was already sent. */
export function wasSkipNotified(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): boolean {
	const entry = prEntry(state, repo, pr)
	return Boolean(entry.notified) && entry.sha === headSha
}

/** Record that the skip notification went out. Pass `file` to persist. */
export function markSkipNotified(
	state: FixState,
	repo: string,
	pr: number | string,
	// Kept for call-site symmetry with markFixed/markSkip; the Python signature
	// carries the head sha here and the port preserved it.
	_headSha: string,
	file?: string,
): PrEntry {
	const entry = prEntry(state, repo, pr)
	entry.notified = true
	if (file !== undefined) saveFixState(file, state)
	return entry
}
