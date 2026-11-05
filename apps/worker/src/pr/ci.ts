// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code; GitHub payloads are untyped JSON
/**
 * CI gate + stale-CI close — port of `scripts/pr-queue-worker.py` lines
 * 395-406 (`check_ci_passed`) and 564-580 (`close_stale_ci_pr`), plus the
 * `STALE_CI_CLOSE_DAYS` constant from line 586.
 *
 * The gate answers one question: is the head SHA's CI green? The close answers
 * the follow-up — a dependabot bump whose CI has failed for days will never
 * pass (the bump is incompatible with the stack), so the worker closes it
 * instead of printing "Waiting for green CI" on it forever.
 *
 * MESSAGE STRINGS ARE THE CONTRACT. They are interpolated into the report
 * buffer and into the close comment, and the worker's own logic branches on
 * substrings of them (`"typecheck" in ci_msg` at Python line 1958, which drives
 * the bun.lock / uv.lock pre-fix). Rewording, re-punctuating or re-ordering any
 * of them silently changes behaviour, so they are transcribed byte for byte.
 *
 * The `failed[:3]` / `pending[:3]` slice is a cap on a NOTIFICATION, not a
 * filter: a 12-check failure list reports its first three, exactly as Python did.
 */
import type { GhClient } from "./scan.ts"

/** Python `STALE_CI_CLOSE_DAYS` (line 586) — used in the close comment. */
export const STALE_CI_CLOSE_DAYS = 2

/**
 * Python's `(ok, msg)` pair, as an object. `unknown` is the port's addition: it
 * separates "CI is red" from "we could not read CI", which the Python collapsed
 * into one `ok` and which the caller must branch on — `unknown` waits, red
 * closes a stale Dependabot PR.
 */
export type CiResult = { ok: boolean; msg: string; unknown?: boolean }

/**
 * Python's `(status, comment_status)` pair from `close_stale_ci_pr` (line 580).
 * A superset of the `{status}` shape the task brief specifies: the PATCH status
 * is what the caller gates on (Python line 2056-2057), but the comment status
 * is the one diagnostic worth keeping when a close "succeeded" without the
 * explanation actually landing.
 */
export type CloseResult = { status: number; commentStatus: number }

/** The first `n` check names, joined — Python lines 403 and 405. */
const NAME_CAP = 3
const joinNames = (checks: any[]): string =>
	checks
		.slice(0, NAME_CAP)
		.map((c) => c?.name)
		.join(", ")

/**
 * Every `conclusion` that means the run did NOT pass.
 *
 * GitHub's set is `success | failure | neutral | cancelled | skipped |
 * timed_out | action_required | stale | startup_failure`. Only `success`,
 * `neutral` and `skipped` are non-blocking; the five below are all "the suite
 * did not run to a pass", and a required-check rule refuses to merge on every
 * one of them. Enumerating the red set rather than the green set is deliberate:
 * a conclusion GitHub adds later defaults to GREEN under a green-list, and this
 * gate's failure mode is a merge.
 */
const FAILED_CONCLUSIONS = new Set([
	"failure",
	"cancelled",
	"timed_out",
	"action_required",
	"stale",
	"startup_failure",
])

/**
 * Python `check_ci_passed(token, repo_full, sha)` (lines 395-406).
 *
 * No CI CONFIGURED is a pass, not a failure: a repo with no checks has nothing
 * to wait for, and blocking it would wedge the worker on a PR that can never
 * turn green. That reading is only safe for a request that SUCCEEDED. The
 * Python answered a failed `request` (status 0, `data: {}` per github.ts) the
 * same way as an empty one — it keyed off the data, not the status — and this
 * port copied that, until GitHub's 2026-10-07 incident made the aliasing
 * expensive: every `/check-runs` call came back 500, `check_runs` read empty,
 * the gate said "No CI configured", and two red Dependabot PRs walked all the
 * way to `stepMerge`. A non-200 now returns `unknown` instead, which the caller
 * treats as "we do not know" — never as green, and never as a reason to close
 * the PR either, because the CI verdict is the very thing that is missing.
 *
 * The check list is read defensively: `data.get("check_runs", [])` only works
 * on a dict, and the Python guards that with `isinstance(data, dict)`. The
 * guard is reproduced rather than assumed, because a null body is a real
 * response shape (a 204 or an error envelope), not a hypothetical.
 */
export async function checkCiPassed(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
): Promise<CiResult> {
	const { status, data } = await api.request("GET", `/repos/${repo}/commits/${sha}/check-runs`, {
		token,
	})
	const checks =
		data !== null && typeof data === "object" && Array.isArray((data as any).check_runs)
			? ((data as any).check_runs as any[])
			: []

	if (!checks.length) {
		// Only a 200 proves "this repo has no checks". A non-200 — the transport
		// sentinel, a 5xx, an error envelope — means we could not read the gate,
		// and green would be a guess.
		if (status !== 200)
			return { ok: false, unknown: true, msg: `⚠️ CI status unavailable (HTTP ${status})` }
		return { ok: true, msg: "✅ No CI configured — skipping CI gate" } // line 399
	}

	// Python lines 400-405. The FAILURE SET, not the single string "failure".
	//
	// GitHub reports nine conclusions, and only `success` means a run passed.
	// This gate used to test `conclusion === "failure"` alone and then treat
	// every `completed` check as green, so a `cancelled`, `timed_out`,
	// `startup_failure`, `action_required` or `stale` run — none of which
	// executed any of the suite — walked through the gate and the worker merged
	// on it. Probed directly: all five returned `✅ 1 checks green`.
	//
	// `neutral` and `skipped` stay GREEN deliberately. They are GitHub's
	// non-blocking verdicts (a path-filtered job, a conditional step) and a
	// required-check rule does not count them as failures either; treating them
	// as red would block every PR in a repo that skips a job on some paths.
	const failed = checks.filter(
		(c) => c?.status === "completed" && FAILED_CONCLUSIONS.has(c?.conclusion),
	)
	if (failed.length) return { ok: false, msg: `CI FAILED: ${joinNames(failed)}` }
	const pending = checks.filter((c) => c?.status !== "completed")
	if (pending.length) return { ok: false, msg: `CI pending: ${joinNames(pending)}` }

	return { ok: true, msg: `✅ ${checks.length} checks green` } // line 406
}

/**
 * Wrap a SHA's CI query so that "this head was never tested" is NOT read as green.
 *
 * THE BUG THIS EXISTS FOR, found by running the loop against a real PR rather than
 * by reading the code. The AI fix committed with the message
 * `fix: auto-fix code quality [skip ci]`, and `[skip ci]` is honoured by GitHub
 * Actions — so NO workflow ran on the commit the agent had just pushed. The only
 * check on that head was a third-party security app. `checkCiPassed` then saw zero
 * failing and zero pending checks and answered `✅ 1 checks green`.
 *
 * The consequence was not theoretical: the worker APPROVED AND MERGED that PR
 * (pr-agent-server#19, `Auto-merge PR #19`) onto a main that was never tested. A red
 * PR can be merged by its own unverified fix.
 *
 * So a caller that KNOWS the head touched code must demand evidence that a real
 * suite ran. The check only ever ADDS refusal: a red or pending verdict passes
 * through untouched.
 *
 * @param expectedChecks job names that must appear, e.g. `["verify"]`. Empty
 *   disables the requirement, preserving `checkCiPassed` for repos with no CI.
 */
export async function checkCiWithSuiteRequirement(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
	expectedChecks: readonly string[],
): Promise<CiResult> {
	const result = await checkCiPassed(api, token, repo, sha)
	// Only a GREEN verdict is suspicious this way.
	if (!result.ok || expectedChecks.length === 0) return result

	const { status, data } = await api.request("GET", `/repos/${repo}/commits/${sha}/check-runs`, {
		token,
	})
	if (status !== 200) return result
	const checks =
		data !== null && typeof data === "object" && Array.isArray((data as any).check_runs)
			? ((data as any).check_runs as any[])
			: []
	const names = new Set(checks.map((c) => String(c?.name ?? "")))
	if (expectedChecks.some((name) => names.has(name))) return result

	return {
		ok: false,
		unknown: true,
		msg: `⚠️ No real CI ran on this head (only: ${[...names].join(", ") || "nothing"}) — likely a [skip ci] commit`,
	}
}

/**
 * Python `close_stale_ci_pr(token, repo_full, pr_num, title, ci_msg)`
 * (lines 564-580).
 *
 * ORDER IS LOAD-BEARING: the comment is POSTed BEFORE the PR is closed, and
 * the comment is best-effort — Python line 576 assigns the comment result and
 * both call sites (lines 1893, 2056) discard it with `_`, so the close happens
 * regardless of whether the comment landed. The comment still goes first
 * because it is the only record of WHY the PR was closed, and a close with no
 * comment leaves a dependabot author with a silent rejection.
 *
 * The em-dashes, backticks and the exact wording are transcribed from Python
 * lines 567-575; they land verbatim on a public PR.
 */
export async function closeStaleCiPr(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
	_title: string,
	ciMsg: string,
): Promise<CloseResult> {
	// `title` is a parameter in the Python signature (line 564) that the comment
	// body never reads. It is KEPT so this call site is the Python's call site —
	// the next task wires the PR loop and should be able to paste the Python's
	// argument list unchanged. `noUnusedParameters` is off, so an unused
	// parameter is not an error here.
	const body =
		`⛔ Auto-closed by PR Queue Worker — **stale failing CI**.\n\n` +
		`CI has been failing for ${STALE_CI_CLOSE_DAYS}+ days on this PR: ` +
		`\`${ciMsg}\`. It will not be merged, and the worker would otherwise ` +
		`wait on it forever.\n\n` +
		// The wording matters. This comment used to call the PR "this dependency
		// bump" and tell the author to open a proper PR — accurate while only
		// dependabot PRs were ever closed, and WRONG now that the policy is
		// inverted and this only ever fires on a human PR. Leaving the old text
		// would tell someone their hand-written work was a dependency bump.
		`If this change is still wanted, re-open it and fix CI, or open a new ` +
		`PR that passes.`

	const comment = await api.request("POST", `/repos/${repo}/issues/${pr}/comments`, {
		token,
		json: { body },
	})
	// Python line 579: the close is NOT conditional on the comment succeeding.
	const closed = await api.request("PATCH", `/repos/${repo}/pulls/${pr}`, {
		token,
		json: { state: "closed" },
	})
	return { status: closed.status, commentStatus: comment.status }
}

/**
 * Close a PR the SAFETY GATE has refused `SAFETY_BLOCK_CEILING` times at one head.
 *
 * WHY A CLOSE AND NOT ANOTHER WAIT. Every other terminal arm in this worker can
 * name something outside itself that would change the answer: green CI, a moved
 * head, a relaxed branch rule. This one cannot. The review body is fixed at a
 * head and `analyzeReviewSafety` is deterministic, so a fourth read returns the
 * fourth identical 0/10 — measured on mcpedia#48, where the two bodies on the PR
 * both score `{safe:false, score:0}` and no third body can appear.
 *
 * The comment is the ONLY record of why a PR vanished from the queue, so it goes
 * first and carries the gate's own reason lines rather than a summary of them —
 * the operator needs to see whether the reviewer found something real or emitted
 * a shape the gate could not read. As with the two close helpers above, the close
 * is not conditional on the comment landing.
 *
 * `dry` is handled by the caller, not here: this function always acts.
 */
export async function closeSafetyBlockedPr(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
	reasons: readonly string[],
	attempts: number,
	headSha: string,
): Promise<CloseResult> {
	const findings = reasons.length
		? reasons.map((r) => `- ${r}`).join("\n")
		: "- (the gate reported no reasons)"
	const body =
		`⛔ Auto-closed by PR Queue Worker — **the safety gate refused this review ${attempts}× at one commit**.\n\n` +
		`The gate scores every review before merging, and this one has not passed. ` +
		`The verdict is fixed at a commit: the worker re-reads the same review body ` +
		`and gets the same answer, so it would otherwise retry this PR forever.\n\n` +
		`**What the gate said:**\n\n${findings}\n\n` +
		`Commit: \`${headSha}\`\n\n` +
		`If the finding above is a real problem, fix it and re-open — the next review ` +
		`is scored from scratch. If it looks wrong (the reviewer described a fix as a ` +
		`concern, or emitted a shape the gate could not read), that is a worker bug, ` +
		`not a problem with this change.`

	const comment = await api.request("POST", `/repos/${repo}/issues/${pr}/comments`, {
		token,
		json: { body },
	})
	const closed = await api.request("PATCH", `/repos/${repo}/pulls/${pr}`, {
		token,
		json: { state: "closed" },
	})
	return { status: closed.status, commentStatus: comment.status }
}
