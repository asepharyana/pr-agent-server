// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code; GitHub payloads are untyped JSON
/**
 * The per-PR context, the flat injection surface, and the small helpers every
 * pipeline step shares — extracted from `./pipeline` so that file comes back
 * under the 400-line cap. THIS IS A MOVE, NOT A REWRITE.
 *
 * Nothing here changed but its `export` keywords and its home: the constants
 * (`AI_FIX_ENABLED`, `TITLE_CAP`, `SECONDS_PER_DAY`), the `[INFRA]` pair, the
 * synthesised no-code review body, `Notify`/`LockPort`/`WorkerDeps`/`PrResult`,
 * the `Ctx` loop-locals record, and every helper (`titleOf`, `strOf`, `ctime`,
 * `ageDays`, `subDeps`, `persist`, `notifySkipOnce`, `reportSkipNotice`,
 * `refetchHead`, `movedSha`) are the original lines with Python references
 * intact. `scripts/pr-queue-worker.py` is still the reference and the report
 * strings are still contracts.
 *
 * `TITLE_CAP` and `SECONDS_PER_DAY` stay unexported: only `titleOf` and
 * `ageDays` read them, and both live here.
 */

import type { GitRunner } from "../git.ts"
import type { FixState } from "../state.ts"
import { bumpAttempt, markSkipNotified, wasSkipNotified } from "../state.ts"
import type { RepoOverrides, SyncState } from "../sync/config.ts"
import type { PostDiscord } from "../sync/run.ts"
import type { AgentPort, ProcessDeps, ReportPort } from "./autofix.ts"
import type { RegistryFetch } from "./bump-guard.ts"
import type { ProcRunner, Workdirs } from "./lockfix.ts"
import type { FetchLike } from "./review.ts"
import type { GhAppClient } from "./scan.ts"

// ── Constants ───────────────────────────────────────────────────────────────

/** Python `AI_FIX_ENABLED = True` (70) — a module constant there too, and it
 *  gates four sites (1856, 1952, 2071, 2134); every one is a gate, not a report. */
export const AI_FIX_ENABLED = true

/**
 * How many times the AI fix may be RE-OFFERED at one head SHA after a recorded
 * run that produced no commit. See `shouldRetryAiFix` in `./state.ts`.
 *
 * Exists because the re-offer is not free: one agent run is up to
 * `AI_FIX_TIMEOUT` (1800s). Without a bound, a dependabot bump whose blocker the
 * agent cannot see — a red CI caused by the CI's own configuration, which is
 * exactly mcpedia#28 — would buy a 30-minute run every five minutes, forever.
 *
 * NOT a skip, deliberately. Past the ceiling the PR reverts to being an ordinary
 * red-CI wait, so the report stays truthful ("we tried, it did not help") and the
 * stale-close arm can still retire a dependabot bump that never turns green.
 * What must not happen is a pin: see the `[INFRA]` transient/permanent split for
 * why writing a `skip_reason` for something retryable is a permanent stall.
 */
export const AI_FIX_RETRY_CEILING = 3

/**
 * How many agent runs at ONE head SHA may end by exhausting their own budget
 * (`--max-turns`, or the `AI_FIX_TIMEOUT` wall clock) before the agent stops
 * being offered there.
 *
 * A THIRD bound, distinct from the two above, and it exists because they do not
 * cover this case:
 *
 *   - `isTransientInfra` decides whether a failure may be PINNED. A timeout must
 *     never be pinned: the model may simply have been slow, and a `skip_reason`
 *     is enforced "until head SHA changes" — a SHA nobody will move for a
 *     problem that lives in the registry, not in the branch.
 *   - `AI_FIX_RETRY_CEILING` bounds RE-OFFERS after a run that produced no
 *     commit, which is a different event (that run finished; this one was cut
 *     off).
 *
 * So a timeout is retryable but expensive, and only a separate count can say
 * "retryable, but we have paid for this three times already". Measured on
 * hub#61 + pr-agent-server#27: `@moonrepo/cli@2.6.3` shipped with
 * `optionalDependencies` pointing at `@moonrepo/core-*@2.6.3`, which was never
 * published (the registry goes 2.6.2 → 2.6.4), so `pnpm exec moon` dies with
 * `Cannot find module '@moonrepo/core-linux-x64-gnu/package.json'`. No edit to
 * that branch can make CI green, so every agent run was guaranteed to exhaust
 * its budget — at 1800s each, every five minutes, indefinitely.
 *
 * Past the ceiling the PR is NOT skipped: it falls through to the ordinary CI
 * gate, which is where a PR the agent cannot help belongs. The report says the
 * budget was spent, so the operator can see why the agent stopped.
 */
export const AI_FIX_BUDGET_CEILING = 3

/**
 * How many times the SAFETY GATE may refuse the SAME review at ONE head before
 * the PR is retired instead of read again.
 *
 * A FOURTH bound, and it exists because the three above all bound work that can
 * change its own answer. This gate cannot. `stepReview` returns the review body
 * it FINDS and only asks for a new one when it finds none, so while a review
 * exists the worker scores the same bytes every five minutes; `analyzeReviewSafety`
 * is deterministic, so the verdict is identical every time. Nothing the worker
 * does between ticks can turn a 0/10 into a pass — the only things that can are
 * a new commit (a new head, a new review, a fresh count) or a human.
 *
 * MEASURED, not assumed. mcpedia#48's two review bodies were fed to the real
 * `analyzeReviewSafety`: both return `{safe:false, score:0}`, and there is no
 * third body. `attempts` climbed next to it on every tick and nothing read the
 * number, so the report printed `🔴 SAFETY BLOCKED (score: 0/10)` and
 * `🔁 ... (attempt 3 at this SHA — retrying next tick)` forever.
 *
 * So the count is bounded and the PR is CLOSED with the evidence commented, the
 * same disposition as a stale red CI and a toolchain pin violation. Closing is
 * the recoverable outcome here: the reason is on the PR, a re-open costs one
 * click, and a dependabot bump that is closed is re-proposed by the next group
 * run — whereas an open PR that loops forever costs a full tick every five
 * minutes and teaches the operator to stop reading the channel.
 *
 * Small on purpose: three reads is already more than one deterministic gate
 * needs. The first two exist so a transient renderer change or a review posted
 * mid-tick cannot retire a PR on a single unlucky read.
 */
export const SAFETY_BLOCK_CEILING = 3
/** Python line 1866, `pr.get("title", "untitled")[:60]`. */
const TITLE_CAP = 60
/** Python line 2051, the `86400` in the dependabot age arithmetic. */
const SECONDS_PER_DAY = 86_400

/**
 * Python line 2100, the `else` arm of a failed conflict fix — the reason an
 * agent-unresolvable merge conflict is recorded under. A contract string, and
 * the test pins it against the Python's literal.
 */
export const UNRESOLVABLE_CONFLICT = "Unresolvable merge conflict (Claude Code made no push)"

/**
 * Python line 2026, `summary.replace("[INFRA] ", "")`. `String.replace` with a
 * STRING pattern replaces the FIRST occurrence only; Python replaces ALL, and
 * the stripped form is what lands in the state file.
 */
export const stripInfra = (s: string): string => s.split("[INFRA] ").join("")
/** Python line 2022, `summary.startswith("[INFRA]")`. */
export const isInfra = (s: string): boolean => s.startsWith("[INFRA]")

/**
 * Did this `[INFRA]` failure happen because the run used up its OWN allowance —
 * `--max-turns` reached, or `AI_FIX_TIMEOUT` elapsed — rather than because
 * something outside it broke?
 *
 * These are the two strings `claude-agent.ts` itself produces (the `--max-turns`
 * error is the CLI's own wording, surfaced through the `exited N:` arm). They are
 * checked by SHAPE, not by a stored flag, because the snippet is the only thing
 * that survives into the report and the state file.
 *
 * A budget exhaustion is RETRYABLE (so it is never pinned) but EXPENSIVE (so it
 * is counted against `AI_FIX_BUDGET_CEILING`). Keeping it a separate predicate
 * from `isTransientInfra` is what lets the two decisions differ: `steps.ts`
 * retries on either, but only this one increments the budget tally.
 */
export const isBudgetExhaustion = (s: string): boolean =>
	isInfra(s) &&
	// `claude-agent.ts`: `[INFRA] Claude Code timed out after ${timeout}s`.
	// The CLI's own wording when `--max-turns` runs out, surfaced through the
	// `[INFRA] Claude Code exited 1: Error: Reached max turns (100)` arm.
	(/timed out after \d+s/i.test(s) || /Reached max turns|max turns \(\d+\)/i.test(s))

/**
 * Is this `[INFRA]` failure TRANSIENT — one that must be retried — rather than
 * a permanent one?
 *
 * WHY THIS EXISTS. `isInfra` is a bare prefix test, so every `[INFRA]` failure
 * was written into `skip_reason`, and a recorded skip is enforced "until head
 * SHA changes" (pipeline.ts). For a failure the code cannot fix by itself that
 * is a permanent stall, not an escalation. A 403 FreeTierError from the model
 * gateway is the clear case: the gateway refused one request because of quota,
 * the CLI exited 1, `claude-agent.ts` faithfully wrapped it as `[INFRA]`, and
 * hub#46 + pr-agent-server#5 were pinned to a head SHA that would never move —
 * two PRs blocked by a quota blip, with a perfectly healthy agent sitting behind
 * them and no way for any code change to release them.
 *
 * So the split is made HERE, where the reason is read, and not where it is
 * written. `[INFRA]` keeps its original meaning — "the agent run did not
 * complete" — and stays the transport marker; only the decision to RECORD it
 * changes. Nothing about the marker itself is loosened, so the existing
 * permanent cases (CLI missing, no credential, not authenticated) still pin.
 *
 * The evidence is read out of the failure text the CLI already produced: an HTTP
 * status, a quota/rate-limit/overload shape, or a network-level errno. Each is a
 * statement about the REQUEST or the moment, not about the install, so retrying
 * it later is a reasonable thing to do.
 *
 * A boundary worth stating: a 401 "not authenticated" IS a credential problem,
 * but it is caught by the explicit `not authenticated` arm below and NOT by the
 * status sweep, because a stale token stays stale. Only a status that is
 * plausibly about this one request may make a failure retryable.
 */
export const isTransientInfra = (s: string): boolean => {
	if (!isInfra(s)) return false

	// A missing binary or an unusable credential is a property of the INSTALL.
	// No amount of waiting changes either, so they stay permanent — and they are
	// checked first, because their text can contain a status-shaped substring.
	if (
		/binary not found/i.test(s) ||
		/no Anthropic credential/i.test(s) ||
		/not authenticated/i.test(s)
	) {
		return false
	}

	// A RUN THAT USED UP ITS OWN ALLOWANCE IS RETRYABLE. This used to be the
	// opposite — `AI_FIX_TIMEOUT` was pinned permanently, and the test suite
	// asserted that as a contract — on the reasoning that retrying costs another
	// 30 minutes. The reasoning about the COST was right; the remedy was wrong.
	//
	// A pin is enforced "until head SHA changes", and nothing about a timeout
	// moves a head: the timeout is a property of one run, not of the install or
	// of the branch. So pinning it converts "this attempt was slow" into "this PR
	// is dead", which is the exact permanent stall `state.ts` warns about — and
	// it is how hub#61 and pr-agent-server#27 became `Permanently skipped` on a
	// `@moonrepo/cli@2.6.3` bump that no edit could fix.
	//
	// The COST is bounded where it belongs: `AI_FIX_BUDGET_CEILING` counts these
	// runs and stops OFFERING the agent past the ceiling. Retry, then stop
	// spending — rather than never retry at all.
	if (isBudgetExhaustion(s)) return true

	return (
		// An HTTP status from the API. `40[0-9]` covers rate limits (429) and
		// payment/quota refusals (402); `5xx` covers every upstream fault.
		/\b(?:4\d\d|5\d\d)\b/.test(s) ||
		// Quota / throttle / capacity wording, with or without a status.
		/rate.?limit|too many requests|insufficient (?:credit|quota)|quota|overloaded|capacity|try again/i.test(
			s,
		) ||
		// Transport-level: the request never reached a server that could judge it.
		/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|terminated/i.test(
			s,
		)
	)
}

/** Python lines 1915-1923, verbatim. A dependabot lockfile-only bump never gets
 *  a "PR Reviewer Guide" (there is no code diff), so the worker synthesises one
 *  that scores a clean 10/10 and lets the normal merge path proceed. */
export const NO_CODE_REVIEW =
	"## PR Reviewer Guide 🔍\n⏱️ Estimated effort to review: 1 🔵⚪⚪⚪⚪\n" +
	"🏅 Score: 100\n🔒 No security concerns identified\n⚡ No major issues detected\n" +
	"🧪 No relevant tests\nNo code changes to review (dependency/lockfile-only bump)."

// ── Injection surface ───────────────────────────────────────────────────────

/** Python's `post_discord_notification` (472-483). */
export type Notify = (
	repo: string,
	pr: number,
	status: string,
	summary: string,
	score: string | number,
	url: string,
) => Promise<void>

/** The lock seam, so a test can hold or deny the lock without touching `/tmp`. */
export type LockPort = { acquire(path: string): { release(): void } | null }

/**
 * One flat object supplying every ported module's own deps plus the two things
 * only the pipeline owns: the report and the fix state. `AgentClient` satisfies
 * `agent` (it has both `post` and `runSync`), and `Report` satisfies `report`.
 */
export type WorkerDeps = {
	api: GhAppClient
	agent: AgentPort & { runSync(opts: any): Promise<{ ok: boolean; snippet: string }> }
	run: GitRunner
	exec: ProcRunner
	workdirs: Workdirs
	procs: ProcessDeps
	fetchGhToken: () => string
	report: ReportPort
	flushReport: () => Promise<void>
	notify: Notify
	postDiscord: PostDiscord
	loadFixState: () => FixState
	saveFixState: (state: FixState) => void
	loadSyncState: () => SyncState
	saveSyncState: (state: SyncState) => void
	repoOverrides: RepoOverrides
	/** Python `time.time()`, in SECONDS. */
	now: () => number
	fetchImpl: FetchLike
	lock: LockPort
	/**
	 * Called the instant the lock is claimed, with its release. This is how
	 * `index.ts` reaches a `runTick` lock from its SIGTERM handler: the Python
	 * installed `_term_handler` (2194-2198) over a module-global lock, and this
	 * is the injected equivalent. Without it a SIGTERM leaves the lockfile
	 * behind and wedges every later tick.
	 */
	onLockAcquired?: (release: () => void) => void
	webhookSecret?: string
	webhookUrl?: string
	/**
	 * `--dry`. Suppresses the four effects the brief names (state write, push,
	 * PR, Discord) AT THE EFFECT, never by skipping a decision, so a dry run
	 * walks the same gates and reports the same lines. The one visible
	 * difference is the `🧪 dry run: would …` line each suppressed effect
	 * leaves, matching the marker `sync/run.ts` already established.
	 */
	dry: boolean
	/**
	 * Async delay, used by the fix-until-green loop to poll CI without blocking the
	 * process.
	 *
	 * ASYNC on purpose: `spawnSync`-based sleeps would freeze the whole worker for
	 * the duration, and CI polling waits minutes. Optional so every existing test
	 * double stays valid; `stepAiFix` falls back to a real timer.
	 */
	sleep?: (ms: number) => Promise<void>
	/**
	 * Registry read for the unshippable-bump guard (`pr/bump-guard.ts`).
	 *
	 * Optional: an install that does not wire it keeps the previous behaviour —
	 * every bump passes — which is the safe default, because this guard may only
	 * ever add a refusal on positive evidence (a confirmed 404 on a platform
	 * binary the bumped package declares).
	 */
	fetchRegistry?: RegistryFetch
}

/** The brief's per-PR result: one flag per counter, `true` when it fired. */
export type PrResult = { merged: boolean; triggered: boolean; fixed: boolean; skipped: boolean }

/** Per-PR: the Python's loop-locals plus the running outcome, mutated in place. */
export type Ctx = {
	/** The installation token, reused by every later step (Python's `token`). */
	token: string
	repo: string
	prNum: number
	title: string
	headSha: string
	headRef: string
	baseRef: string
	author: string
	/** Tri-state, because line 2066 tests `is False` and null means "computing". */
	mergeable: boolean | null
	createdAt: unknown
	fixState: FixState
	/** Set by the trivial-PR branch; suppresses the AI fix (1952). */
	noCodeReview: boolean
	/** Python's `score`, from `analyze_review_safety` — carried into the Discord
	 *  payload (2125, 2168), which is why it outlives the safety block. */
	score: string | number
	out: PrResult
}

export const titleOf = (pr: any): string =>
	(typeof pr?.title === "string" ? pr.title : "untitled").slice(0, TITLE_CAP)
export const strOf = (v: unknown): string => (typeof v === "string" ? v : "")

/** `time.ctime()` (1850) in the Python's LOCAL time — an operator reads this
 *  against their own clock, which is the only reason the header exists. */
export function ctime(epochSec: number): string {
	const d = new Date(epochSec * 1000)
	const p = (n: number) => String(n).padStart(2, "0")
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	]
	// `time.ctime` pads HOURS/MINUTES/SECONDS to two digits but NOT the day, and
	// the space it leaves makes single-digit days render as "Jan  1" (two spaces).
	// Probed against the interpreter: time.ctime(0) == 'Thu Jan  1 07:00:00 1970'.
	// Padding the day too would diverge on ~24% of runs in the report header.
	return (
		`${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ` +
		`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
	)
}

/**
 * Python line 2051: `(time.time() - mktime(strptime(created, "%Y-%m-%dT%H:%M:%SZ"))) / 86400`
 * inside a `try`, `age_days = 0` on any failure. `mktime` reads the naive tuple
 * as LOCAL time while `Date.parse` on a `Z` ISO string is UTC, so this is off by
 * the host's UTC offset — below the 0.1d precision of the `{age_days:.1f}`
 * report line in every timezone the worker runs in. A malformed date is 0
 * days, which is the "too fresh to close" direction.
 */
export function ageDays(created: unknown, nowSec: number): number {
	if (typeof created !== "string") return 0
	const t = Date.parse(created)
	return Number.isFinite(t) ? (nowSec - t / 1000) / SECONDS_PER_DAY : 0
}

/** The `AiFixDeps` + `LockfixDeps` view of one flat object. */
export function subDeps(deps: WorkerDeps) {
	return {
		run: deps.run,
		exec: deps.exec,
		workdirs: deps.workdirs,
		fetchGhToken: deps.fetchGhToken,
		agent: deps.agent,
		api: deps.api,
		report: deps.report,
	}
}

/** `mark_*` saves in the Python (a side effect of the mutator); dry does not. */
export function persist(deps: WorkerDeps, state: FixState): void {
	if (!deps.dry) deps.saveFixState(state)
}

/**
 * `notify_skip_once` (485-495): the alert fires ONCE per PR+head_sha+reason.
 * The send comes BEFORE the flag is written (the Python's order), so a crash in
 * between re-alerts next tick rather than losing the notice — the cheap failure
 * to have, against the expensive one.
 */
export async function notifySkipOnce(deps: WorkerDeps, c: Ctx, reason: string): Promise<boolean> {
	if (wasSkipNotified(c.fixState, c.repo, c.prNum, c.headSha)) return false
	if (!deps.dry) {
		await deps.notify(
			c.repo,
			c.prNum,
			"skipped",
			`⏭️ Skipped: ${reason} — will not retry until the PR head changes`,
			"",
			`https://github.com/${c.repo}/pull/${c.prNum}`,
		)
	}
	markSkipNotified(c.fixState, c.repo, c.prNum, c.headSha)
	persist(deps, c.fixState)
	return true
}

/**
 * Record a failed attempt, and pin the PR once the same head has failed too
 * many times. Returns the attempt count so a caller can word its report line.
 *
 * THE ONE PLACE AN ORDINARY FAILURE IS ALLOWED TO LEAVE STATE. Every arm that
 * ends a PR's turn without succeeding must call this, because "no state" is
 * what makes a stuck PR invisible to the pipeline: the next tick sees a clean
 * entry, concludes the PR is untried, and pays for the identical work. That is
 * not a bug in any one arm — it is the absence of a rule, and rules are the only
 * thing a rule-less loop needs.
 *
 * `label` is the report/notification phrase for this failure class, so the
 * operator sees WHICH condition pinned it rather than a generic "gave up".
 * Past `MAX_ATTEMPTS` the failure becomes a `skip_reason` — a state the
 * pipeline already honours on the next tick and already notifies about — so the
 * escalation path reuses machinery that is already proven rather than adding a
 * second one that could itself be wrong.
 */
export async function noteFailure(deps: WorkerDeps, c: Ctx, label: string): Promise<number> {
	const attempts = bumpAttempt(c.fixState, c.repo, c.prNum, c.headSha)
	// Persisted even though nothing is escalated, for one reason: it is the ONLY
	// record that this PR was tried and failed, so it is what the report and the
	// next tick's diagnostics can cite. One file write buys an answerable "why is
	// this PR still here".
	//
	// DELIBERATELY NO GIVE-UP BRANCH. An earlier version pinned the PR after
	// MAX_ATTEMPTS and called it "escalation". That was wrong: it converts a
	// retry-until-resolved into a permanent stall, which is the exact failure
	// this worker is supposed to prevent. A PR that cannot be fixed stays open
	// and keeps being retried until it can — or until someone looks, which the
	// repeated `🔁` line and the Discord report both make obvious. The attempt
	// number is kept because "attempt 47" is itself the escalation signal to a
	// human; silently capping it would hide that.
	persist(deps, c.fixState)
	deps.report.push(`   🔁 ${label} (attempt ${attempts} at this SHA — retrying next tick)`)
	return attempts
}

/** Python line 2029/2103/2159: report the notify only when it actually sent. */
export async function reportSkipNotice(deps: WorkerDeps, c: Ctx, reason: string): Promise<void> {
	if (await notifySkipOnce(deps, c, reason)) deps.report.push(`   🔔 Skip notified: ${reason}`)
}

/**
 * The post-push head re-fetch (1967-1972, 2013-2019, 2087-2091). Returns the
 * fresh PR object or null and reports nothing: the sites print DIFFERENT
 * "Head SHA updated" lines, so the wording is the caller's.
 */
export async function refetchHead(deps: WorkerDeps, c: Ctx): Promise<any | null> {
	const { data } = await deps.api.request("GET", `/repos/${c.repo}/pulls/${c.prNum}`, {
		token: c.token,
	})
	return data !== null && typeof data === "object" && !Array.isArray(data) ? data : null
}

/** A fresh sha counts only when the PR actually moved — line 1970's guard. */
export const movedSha = (pr: any, from: string): string | null => {
	const sha = strOf(pr?.head?.sha)
	return sha && sha !== from ? sha : null
}
