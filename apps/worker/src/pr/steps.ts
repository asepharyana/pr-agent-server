/**
 * STEPS A0 / A / A2 / B — the walk from "a PR arrived" to "the AI fix has run or
 * declined to", extracted verbatim from `./pipeline` for the 400-line cap. THIS
 * IS A MOVE, NOT A REWRITE.
 *
 * The ORDER here is the product and it is unchanged: the pin guard runs BEFORE
 * the review and its end-of-turn is unconditional (Python 1885/1899), a
 * triggered review is NOT a skip (1934), and the trivial-PR lockfile pre-fix
 * (1953-1986) runs before the agent. Every report string, the emoji, the two
 * spaces after `⏭️`/`⚠️` and the 3-space indent are the Python's.
 *
 * The three-way bun/uv arm in `stepLockPrefix` keeps its explanatory comment
 * because it is the load-bearing part of that function, not decoration.
 */

import {
	badBumpReason,
	budgetRunCount,
	bumpAttempt,
	bumpBudgetRun,
	clearReviewRequest,
	markBadBump,
	markFixed,
	markReviewRequested,
	markSkip,
	reviewRequestCount,
	reviewRequestedAt,
} from "../state.ts"
import { checkPrStillValid, killOrphanedAgent, runAiFix } from "./autofix.ts"
import { commentBadBump, findBadBump } from "./bump-guard.ts"
import { checkCiPassed } from "./ci.ts"
import {
	AI_FIX_BUDGET_CEILING,
	AI_FIX_ENABLED,
	type Ctx,
	isBudgetExhaustion,
	isInfra,
	isTransientInfra,
	movedSha,
	NO_CODE_REVIEW,
	persist,
	refetchHead,
	reportSkipNotice,
	stripInfra,
	subDeps,
	type WorkerDeps,
} from "./context.ts"
import {
	CI_WAIT_TIMEOUT_MS,
	EXPECTED_CI_CHECKS,
	iterationLine,
	MAX_FIX_ITERATIONS,
	shouldIterateAgain,
	waitForCiSettled,
} from "./fix-loop.ts"
import { fixBunLock, fixUvLock, isTrivialPr, repoHasBunLock } from "./lockfix.ts"
import { closeToolchainPr, TOOLCHAIN_PINS, toolchainPinViolation } from "./pins.ts"
import { findReviewComment, findTrivialNoReviewMarker, triggerReview } from "./review.ts"

/**
 * How long a requested-but-missing review must be outstanding before the worker
 * fires it a second time.
 *
 * A healthy review on this deployment lands in seconds (measured: 22s for a
 * two-PR tick), so 15 minutes cannot collide with one still in flight. The wait
 * exists because the window is not "is the reviewer slow" but "did the job die":
 * the webhook answers 2xx before any token is generated, so a review can be
 * accepted, fail server-side and leave no trace on the PR. Re-firing inside that
 * window would double-pay for a review that is about to post.
 */
const REVIEW_RETRY_AFTER_MIN = 15

// ── STEP A0 — toolchain pin guard (1882-1899) ───────────────────────────────

/** True when the PR's turn is over. Closes dependabot bumps of a pinned major. */
export async function stepPinGuard(deps: WorkerDeps, c: Ctx): Promise<boolean> {
	if (c.author !== "dependabot[bot]") return false
	const violation = toolchainPinViolation(c.repo, c.title)
	if (!violation) return false
	const [pkg, oldVer, newVer] = violation

	deps.report.push(
		`   ⛔ Toolchain pin violation: ${pkg} ${oldVer} → ${newVer} (allowed major ${TOOLCHAIN_PINS[c.repo][pkg]})`,
	)
	if (deps.dry) {
		deps.report.push(`   🧪 dry run: would close #${c.prNum} (pin violation)`)
		c.out.skipped = true
		return true
	}
	const { status } = await closeToolchainPr(deps.api, c.token, c.repo, c.prNum, pkg, oldVer, newVer)
	if (status === 200) {
		deps.report.push(`   ✅ Closed #${c.prNum} (pin violation)`)
		c.out.skipped = true // Python counts a skip ONLY on a 200 close.
	} else {
		deps.report.push(`   ⚠️  Close failed HTTP ${status} — leaving open`)
	}
	return true
}

// ── STEP A — review (1901-1936) ─────────────────────────────────────────────

/**
 * Returns the review body, or null when the PR STOPS for this tick — a review
 * was just triggered and needs a cycle.
 */
export async function stepReview(deps: WorkerDeps, c: Ctx): Promise<string | null> {
	const found = await findReviewComment(deps.api, c.token, c.repo, c.prNum)
	if (found) {
		deps.report.push("   📝 Review found")
		// A review arrived, so nothing is owed: clearing the record is what stops
		// the "never landed" warning below from firing on a PR that is now fine.
		if (reviewRequestCount(c.fixState, c.repo, c.prNum, c.headSha) > 0) {
			clearReviewRequest(c.fixState, c.repo, c.prNum)
			persist(deps, c.fixState)
		}
		return found
	}
	// The trivial-PR branch (1912-1923) is a fix, not an optimisation: a
	// lockfile-only bump yields "No code suggestions found" rather than a guide,
	// and re-triggering every five minutes produced duplicate comment spam.
	if (
		isTrivialPr(c.title, c.author) &&
		(await findTrivialNoReviewMarker(deps.api, c.token, c.repo, c.prNum))
	) {
		deps.report.push(
			"   📝 PR-Agent assessed (no-code/lockfile PR) — no code to review, treating as reviewed",
		)
		c.noCodeReview = true
		return NO_CODE_REVIEW
	}

	// A review was already ASKED FOR at this head and never appeared. The trigger
	// returned 2xx, so the request was accepted — but 2xx only means "enqueued"
	// (handle-webhook.ts answers before any token is generated), so a review can
	// be accepted and then die server-side with nothing posted. That is exactly
	// what happened on 2026-10-28: the LLM key was scoped to one model, every
	// review failed with a 403, and this code printed
	// "✅ PR-Agent triggered (HTTP 200)" on every tick for hours.
	//
	// Say so, loudly, instead of re-printing a success line. A single re-fire is
	// allowed once the wait has clearly outlived a normal review, because the
	// failure that motivates this branch is often transient (a bad sample, a
	// gateway blip) and the job that died left no trace on the PR. Past that
	// limit the request is NOT repeated: each retry is a paid job queued behind
	// the same fault, and re-firing forever is what turns a broken reviewer into
	// a silent money leak. The evidence a human needs (the reviewer's own error)
	// lives in the server's journal, so the report points there.
	const priorRequests = reviewRequestCount(c.fixState, c.repo, c.prNum, c.headSha)
	if (priorRequests > 0) {
		const requestedAt = reviewRequestedAt(c.fixState, c.repo, c.prNum, c.headSha) ?? 0
		const waitedMin = Math.max(0, Math.round((deps.now() - requestedAt) / 60))
		deps.report.push(
			`   ⚠️  Review requested ${priorRequests}× at this SHA, no review after ${waitedMin}m`,
		)

		// One recovery attempt, only after a wait no healthy review would exceed.
		// `priorRequests` counting is what bounds it: the re-fire marks the request
		// again, so the next tick sees 2 and goes to the give-up branch below.
		if (waitedMin >= REVIEW_RETRY_AFTER_MIN && priorRequests < 2 && !deps.dry) {
			deps.report.push(
				`   🔁 No review after ${waitedMin}m — re-triggering once (the previous job died server-side)`,
			)
		} else {
			deps.report.push(
				"   🚨 PR-Agent accepted the request (HTTP 2xx) but never posted a review — the reviewer is failing server-side; check its journal. Not re-triggering.",
			)
			c.out.skipped = true
			return null
		}
	}

	deps.report.push("   📡 No review → triggering PR-Agent...")
	const result = await triggerReview(
		{
			api: deps.api,
			fetchImpl: deps.fetchImpl,
			webhookSecret: deps.webhookSecret,
			webhookUrl: deps.webhookUrl,
		},
		c.repo,
		c.prNum,
		c.title,
		c.headSha,
		c.headRef,
		c.baseRef,
	)
	if (typeof result === "number" && result >= 200 && result < 300) {
		// Record the REQUEST, not a success — no review exists yet, and the next
		// tick is what decides whether one ever arrives.
		markReviewRequested(c.fixState, c.repo, c.prNum, c.headSha, deps.now())
		persist(deps, c.fixState)
		deps.report.push(`   ✅ PR-Agent accepted the request (HTTP ${result}) — awaiting the review`)
		c.out.triggered = true
	} else {
		deps.report.push(`   ⚠️  Trigger result: ${result}`)
	}
	return null
}

// ── STEP A2 — lockfile pre-fix for trivial PRs (1953-1986) ─────────────────

/**
 * For a lockfile-only PR whose CI is red on a lockfile check, re-resolve and
 * push the lockfile BEFORE the AI agent runs. `bun.lock` first for a Bun repo;
 * `uv.lock` is the fallback, SKIPPED when the CI message already names it
 * (1973) — re-resolving the file uv just complained about costs a clone and
 * changes nothing.
 */
export async function stepLockPrefix(deps: WorkerDeps, c: Ctx): Promise<void> {
	const early = await checkCiPassed(deps.api, c.token, c.repo, c.headSha)
	if (early.ok || !early.msg.includes("typecheck")) return
	// Python 1961-1973 is a THREE-way, not a two-way with a default:
	//   if has_bun:                    -> fix_bun_lock
	//   elif "uv.lock" not in ci_msg:  -> fix_uv_lock
	//   (else)                         -> fall through, change nothing
	//
	// The third arm is the load-bearing one: a CI message that already names
	// uv.lock is complaining about the file uv would re-resolve, so re-resolving
	// costs a clone, changes nothing, and in a non-Bun repo the naive two-way
	// rewrite ends up PUSHING a regenerated bun.lock the repo does not use, on a
	// PR the Python left untouched. It cannot be a disjunction at all: `has_bun`
	// alone must select bun (a Bun repo is unaffected by what CI names), and the
	// negative guard belongs on the uv arm only.
	const hasBun = await repoHasBunLock(deps.api, c.token, c.repo, c.headSha)
	const uvBlocked = early.msg.includes("uv.lock")
	if (!hasBun && uvBlocked) return // Python 1973's implicit else.
	const useBun = hasBun

	deps.report.push(
		useBun
			? "   🔧 CI failing: bun.lock stale — pre-fixing..."
			: "   🔧 CI failing: uv.lock stale — pre-fixing...",
	)
	if (deps.dry) {
		deps.report.push("   🧪 dry run: would re-resolve and push the lockfile")
		return
	}
	const { ok, summary } = useBun
		? await fixBunLock(subDeps(deps), c.repo, c.prNum, c.headRef, c.baseRef)
		: await fixUvLock(subDeps(deps), c.repo, c.prNum, c.headRef, c.baseRef)
	if (!ok) return // Python 1965: a failed fix reports nothing and moves on.

	deps.report.push(`   ✅ ${summary}`)
	const sha = movedSha(await refetchHead(deps, c), c.headSha)
	if (sha) {
		deps.report.push("   🔄 Head SHA updated")
		c.headSha = sha
	}
}

// ── STEP A1 — unshippable-bump guard ────────────────────────────────────────

/**
 * Refuse a Dependabot bump that cannot install, BEFORE any agent run.
 *
 * THE COST THIS SAVES. `hub#61` + `pr-agent-server#27` were a
 * `@moonrepo/cli@2.6.3` bump whose platform binaries were never published. The
 * agent's prompt says "Make the failing job pass. Do not work around it", and no
 * edit to that branch can — so each run was guaranteed to burn its full
 * `--max-turns`/1800s budget and then be pinned. This check is two registry
 * reads on the FIRST tick instead.
 *
 * It returns true when the PR's turn is over. The PR is NOT closed: closing a
 * Dependabot bump is a silent loss, so the evidence is commented and a human
 * decides. The cached reason makes later ticks free.
 *
 * `deps.fetchRegistry` is optional: an install that does not wire it keeps the
 * previous behaviour exactly (every bump passes), which is the safe default —
 * this guard may only ever ADD a refusal on positive evidence.
 */
export async function stepBumpGuard(deps: WorkerDeps, c: Ctx): Promise<boolean> {
	if (c.author !== "dependabot[bot]") return false
	const cached = badBumpReason(c.fixState, c.repo, c.prNum, c.headSha)
	if (cached) {
		deps.report.push(`   ⛔ Unshippable bump (cached at this SHA): ${cached}`)
		c.out.skipped = true
		return true
	}
	if (!deps.fetchRegistry) return false

	const bad = await findBadBump(c.title, deps.fetchRegistry)
	if (!bad) return false

	deps.report.push(`   ⛔ Unshippable bump: ${bad.reason}`)
	markBadBump(c.fixState, c.repo, c.prNum, c.headSha, bad.reason)
	persist(deps, c.fixState)
	if (deps.dry) {
		deps.report.push(`   🧪 dry run: would comment the evidence on #${c.prNum}`)
		c.out.skipped = true
		return true
	}
	const status = await commentBadBump(deps.api, c.token, c.repo, c.prNum, bad)
	deps.report.push(
		status >= 200 && status < 300
			? "   💬 Evidence commented — left open for a human, AI fix skipped"
			: `   ⚠️  Could not comment the evidence (HTTP ${status})`,
	)
	c.out.skipped = true
	return true
}

// ── STEP B — AI fix (1951-2029) ─────────────────────────────────────────────

/**
 * Runs the agent on the PR branch, or skips because this SHA was handled
 * already. `check_pr_still_valid` runs FIRST (1993) so a PR closed under us is
 * not paid for, and its NEW head is adopted (1998-2000) so the merge path
 * re-reads reality instead of a stale sha.
 */
export async function stepAiFix(deps: WorkerDeps, c: Ctx, already: boolean): Promise<void> {
	if (!AI_FIX_ENABLED || c.noCodeReview) return
	// Python line 1956: `is_trivial_pr(title, author) and not already`.
	if (isTrivialPr(c.title, c.author) && !already) await stepLockPrefix(deps, c)

	if (already) {
		deps.report.push("   ⏭️  Already fixed at this SHA — skip AI fix")
		return
	}
	// THE BUDGET CEILING. A run that ends by exhausting its own allowance (turn
	// cap or wall clock) is retryable — see `isTransientInfra` — but it costs up
	// to `AI_FIX_TIMEOUT` (1800s) of a paid model, so it cannot be retried
	// without limit. Past `AI_FIX_BUDGET_CEILING` the agent is simply not
	// offered, and the PR falls through to the ordinary CI gate.
	//
	// NOT a skip, deliberately: a `skip_reason` is enforced "until head SHA
	// changes", which is a permanent stall for a blocker that lives outside the
	// branch. The PR stays visible, stays counted, and stays mergeable the
	// moment CI is green for any other reason (a base-branch fix, a maintainer
	// bumping the dependency properly).
	const budgetRuns = budgetRunCount(c.fixState, c.repo, c.prNum, c.headSha)
	if (budgetRuns >= AI_FIX_BUDGET_CEILING) {
		deps.report.push(
			`   ⏭️  Agent budget spent ${budgetRuns}× at this SHA — leaving it to the CI gate (not a skip)`,
		)
		return
	}
	if (deps.dry) {
		deps.report.push("   🧪 dry run: would run the Hermes AI fix")
		return
	}

	// ── FIX UNTIL CI IS GREEN ────────────────────────────────────────────────
	//
	// The single-shot flow below this line ends the moment a commit is pushed.
	// Nothing asked whether that push actually fixed CI, so a fix that did not
	// work looked exactly like one that did — and since the push moves the head,
	// the next tick's `alreadyFixed` printed "Already fixed at this SHA" and
	// waited forever. mcpedia#28 spent 97 ticks that way.
	//
	// This loop closes it: run the agent, wait for GitHub to settle CI on the new
	// head, read the NEW failure, and run again with that failure in the prompt —
	// until green, or the budget is spent. Every iteration reports itself, so the
	// operator sees the spend rather than discovering it.
	const maxIterations = MAX_FIX_ITERATIONS
	for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
		const [valid, newSha, newMergeable, reason] = await checkPrStillValid(
			deps.api,
			c.token,
			c.repo,
			c.prNum,
			c.headSha,
		)
		if (!valid) {
			deps.report.push(`   ⏭️  PR changed: ${reason}`)
			if (newSha) {
				c.headSha = newSha
				c.mergeable = typeof newMergeable === "boolean" ? newMergeable : null
			}
			return
		}

		killOrphanedAgent(deps.procs, c.repo, c.prNum)
		const { ok, summary, commits, tipSha } = await runAiFix(
			subDeps(deps),
			c.repo,
			c.prNum,
			c.title,
			c.headSha,
			c.headRef,
			c.baseRef,
			c.token,
		)

		if (!ok) {
			// A genuine failure ends the loop: retrying an [INFRA] fault or a
			// clone error costs another 30 minutes and reaches the same place.
			await reportAiFixFailure(deps, c, summary)
			return
		}

		deps.report.push(`   ✨ ${summary}`)
		markFixed(c.fixState, c.repo, c.prNum, tipSha || c.headSha, commits)
		persist(deps, c.fixState)
		c.out.fixed = true

		if (commits === 0) {
			// Nothing was pushed. There is no new head, but there may still be a RED
			// CI — and that is not nothing. The agent found no code to improve, which
			// for a CI blocker (a config fault, a bad test assertion) is the honest
			// answer and also exactly the state mcpedia#28 died in: `Already fixed`
			// then silence, forever.
			//
			// So instead of returning, read the CURRENT failure and say it. It costs
			// one API round-trip and turns a dead end into a diagnosis the operator
			// and the notification can act on. It does NOT re-run the agent: the same
			// tree with the same evidence would produce the same nothing, which is
			// the loop the retry ceiling exists to prevent.
			deps.report.push("   ⏭️  Agent committed nothing — no new head to verify")
			const fresh = await refetchHead(deps, c)
			const sha = movedSha(fresh, c.headSha)
			if (sha) c.headSha = sha
			const current = await checkCiPassed(deps.api, c.token, c.repo, c.headSha)
			if (!current.ok && !current.unknown) {
				deps.report.push(`   ⚠️  CI is red and the agent could not fix it: ${current.msg}`)
				deps.report.push("   ⏭️  Needs a human, or a wider change than this agent may make")
			}
			return
		}

		// New commit on the branch: adopt the head and WAIT for CI on it.
		const fresh = await refetchHead(deps, c)
		const sha = movedSha(fresh, c.headSha)
		if (sha) {
			deps.report.push("   🔄 Head SHA updated for merge")
			c.headSha = sha
			c.mergeable = typeof fresh?.mergeable === "boolean" ? fresh.mergeable : null
		}

		const verdict = await waitForCiSettled(deps.api, c.token, c.repo, c.headSha, {
			sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
			// The fix MUST be verified by the real suite: a head with no workflow run
			// reads as green on zero checks otherwise, which is how an untested fix
			// got auto-merged.
			expectedChecks: EXPECTED_CI_CHECKS,
		})
		if (verdict.ci.ok) {
			deps.report.push(`   ✅ CI green after iteration ${iteration} — ${verdict.ci.msg}`)
			return
		}
		if (verdict.timedOut) {
			deps.report.push(
				`   ⏳ CI still pending after ${Math.round(CI_WAIT_TIMEOUT_MS / 1000)}s — leaving it to the CI gate`,
			)
			return
		}
		// An unknown gate is not an invitation to retry: a fix aimed at an
		// unreadable failure would be guesswork, and silence is not a pass.
		if (verdict.ci.unknown) {
			deps.report.push(`   ⚠️  ${verdict.ci.msg} — cannot verify, not iterating`)
			return
		}
		if (!shouldIterateAgain(verdict, iteration, maxIterations)) {
			deps.report.push(
				`   ⚠️  CI still red after ${maxIterations} fix iteration(s) — ${verdict.ci.msg}`,
			)
			deps.report.push("   ⏭️  Leaving it to the CI gate; the next tick starts from the new head")
			return
		}
		deps.report.push(iterationLine(iteration, maxIterations, verdict.ci))
	}
}

/**
 * Report a fix attempt that FAILED (as opposed to one that completed with no
 * commit). Extracted so the iteration loop can call it without duplicating the
 * transient/permanent split — that split is the difference between "retry next
 * tick" and "pin this SHA forever", and two copies of it would eventually drift.
 */
async function reportAiFixFailure(deps: WorkerDeps, c: Ctx, summary: string): Promise<void> {
	deps.report.push(`   ⏭️  AI fix skipped: ${summary}`)
	// A run cut off by its own turn/time allowance is counted FIRST, because it
	// is both retryable (never pinned — see `isTransientInfra`) and expensive
	// (capped by `AI_FIX_BUDGET_CEILING`). The two arms below cannot express
	// that: one pins, the other counts without a ceiling.
	if (isBudgetExhaustion(summary)) {
		const runs = bumpBudgetRun(c.fixState, c.repo, c.prNum, c.headSha)
		persist(deps, c.fixState)
		const left = AI_FIX_BUDGET_CEILING - runs
		deps.report.push(
			left > 0
				? `   🔁 Agent exhausted its budget (${runs}/${AI_FIX_BUDGET_CEILING} at this SHA — retrying next tick)`
				: `   ⏭️  Agent budget spent (${runs}/${AI_FIX_BUDGET_CEILING}) — leaving it to the CI gate, not a skip`,
		)
		return
	}
	if (isInfra(summary) && !isTransientInfra(summary)) {
		// Infra-level failure (CLI missing / no credential): permanently skip at
		// this SHA, or retrying every 5 min would just loop (2023-2025).
		const why = stripInfra(summary)
		markSkip(c.fixState, c.repo, c.prNum, c.headSha, why)
		persist(deps, c.fixState)
		await reportSkipNotice(deps, c, why)
		return
	}
	if (isTransientInfra(summary)) {
		// A TRANSIENT infra failure — a 4xx/5xx from the gateway, a quota or
		// rate-limit refusal, a socket error. Deliberately NOT recorded: a
		// `skip_reason` is enforced "until head SHA changes", and nothing will
		// move that SHA, because the fix is quota or a token rather than a code
		// change. Recording it is how a 403 FreeTierError once pinned hub#46 and
		// pr-agent-server#5 for good with a healthy agent sitting behind them.
		//
		// `bumpAttempt` records the failure as a DIAGNOSTIC (the report can then
		// say "attempt 7"), and it is still not a ceiling — nothing reads it to
		// decide to give up, so the next tick simply tries again.
		const attempts = bumpAttempt(c.fixState, c.repo, c.prNum, c.headSha)
		persist(deps, c.fixState)
		deps.report.push(`   🔁 Transient infra failure — will retry next tick (attempt ${attempts})`)
	}
}
