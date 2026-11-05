/**
 * The terminal gates and the shared conflict resolver — extracted verbatim from
 * `./pipeline` for the 400-line cap. THIS IS A MOVE, NOT A REWRITE.
 *
 * `resolveConflict` is the one block the Python wrote TWICE (2071-2105 and
 * 2134-2161), byte-identical except for the report line and whether the head is
 * re-fetched, so it is one function here with those two differences as
 * parameters. It is exported because its two call sites are in different files:
 * `stepMerge` below, and `processPr` in `./pipeline`.
 *
 * `stepSafetyAndCi` and `stepMerge` are here because every one of their arms
 * ENDS the PR's turn — the safety block's `score` is carried out through `Ctx`
 * and the two dry-run arms are the ones that report what they would have done.
 * The stale-dependabot age arithmetic (Python 2051) is `ageDays` in `./context`.
 */

import {
	alreadyFixed,
	bumpAttempt,
	bumpBudgetRun,
	bumpSafetyBlock,
	markFixed,
	markSkip,
} from "../state.ts"
import { checkPrStillValid, killOrphanedAgent, runAiFix } from "./autofix.ts"
import { checkCiPassed, closeSafetyBlockedPr, closeStaleCiPr, STALE_CI_CLOSE_DAYS } from "./ci.ts"
import {
	AI_FIX_BUDGET_CEILING,
	AI_FIX_ENABLED,
	ageDays,
	type Ctx,
	isBudgetExhaustion,
	isInfra,
	isTransientInfra,
	movedSha,
	noteFailure,
	persist,
	refetchHead,
	reportSkipNotice,
	SAFETY_BLOCK_CEILING,
	stripInfra,
	strOf,
	subDeps,
	UNRESOLVABLE_CONFLICT,
	type WorkerDeps,
} from "./context.ts"
import { approvePr, mergePr } from "./merge.ts"
import { analyzeReviewSafety } from "./safety.ts"

// ── The conflict resolver, used from TWO sites (2071-2105 and 2134-2161) ────

/**
 * The "resolve this conflict with the agent, once per head SHA" block. The
 * Python writes it twice, byte-identical except for the report line and for
 * whether the head is re-fetched, so it is one function here with those two
 * differences as parameters: `recheck` is the 2066 site, and the 409 site does
 * NOT re-fetch.
 *
 * Always ends the PR's turn — success, failure and give-up all `continue` — so
 * it returns nothing and the caller counts the outcomes.
 */
export async function resolveConflict(
	deps: WorkerDeps,
	c: Ctx,
	already: boolean,
	onFixed: string,
	recheck: boolean,
): Promise<void> {
	const giveUp = recheck
		? "   ⏭️  Skipping (conflict, already attempted at this SHA)"
		: "   ⏭️  Skipping (409 conflict, already attempted)"
	if (AI_FIX_ENABLED && !already) {
		if (deps.dry) {
			deps.report.push("   🧪 dry run: would ask the agent to resolve the merge conflict")
			return
		}
		const [valid] = await checkPrStillValid(deps.api, c.token, c.repo, c.prNum, c.headSha)
		if (valid) {
			deps.report.push("   🤖 Resolving merge conflict with Claude Code...")
			killOrphanedAgent(deps.procs, c.repo, c.prNum)
			const { ok, summary, tipSha } = await runAiFix(
				subDeps(deps),
				c.repo,
				c.prNum,
				c.title,
				c.headSha,
				c.headRef,
				c.baseRef,
				c.token,
			)
			if (ok) {
				deps.report.push(`   ✨ Conflict resolved: ${summary}`)
				// The pushed tip, not the pre-push head — the same rule as
				// `stepAiFix`, and for the same reason: a record naming the head the
				// agent started from is invalidated by the resolve's own push, and
				// the next tick then offers the agent the branch all over again.
				markFixed(c.fixState, c.repo, c.prNum, tipSha || c.headSha)
				persist(deps, c.fixState)
				c.out.fixed = true
				if (recheck) {
					const sha = movedSha(await refetchHead(deps, c), c.headSha)
					if (sha) deps.report.push(onFixed)
				} else {
					deps.report.push(onFixed)
				}
				return
			}
			deps.report.push(`   ⏭️  Conflict fix failed: ${summary}`)
			// Same transient/permanent split as `stepAiFix`, and for the same reason:
			// a gateway 4xx/5xx here would otherwise be recorded in `skip_reason` and
			// enforced "until head SHA changes", which no conflict-resolution run will
			// ever move. A budget exhaustion is the same shape but counted separately,
			// so an expensive timeout cannot repeat without limit.
			if (isBudgetExhaustion(summary)) {
				const runs = bumpBudgetRun(c.fixState, c.repo, c.prNum, c.headSha)
				persist(deps, c.fixState)
				deps.report.push(
					`   🔁 Agent exhausted its budget (${runs}/${AI_FIX_BUDGET_CEILING} at this SHA — retrying next tick)`,
				)
				return
			}
			if (isTransientInfra(summary)) {
				const attempts = bumpAttempt(c.fixState, c.repo, c.prNum, c.headSha)
				persist(deps, c.fixState)
				deps.report.push(
					`   🔁 Transient infra failure — will retry next tick (attempt ${attempts})`,
				)
				return
			}
			const why = isInfra(summary) ? stripInfra(summary) : UNRESOLVABLE_CONFLICT
			markSkip(c.fixState, c.repo, c.prNum, c.headSha, why)
			persist(deps, c.fixState)
			await reportSkipNotice(deps, c, why)
			return
		}
	}
	deps.report.push(giveUp)
}

// ── STEP C/D — safety + CI gate (2031-2064) ─────────────────────────────────

/** True when the PR stops here. */
export async function stepSafetyAndCi(deps: WorkerDeps, c: Ctx, review: string): Promise<boolean> {
	const safety = analyzeReviewSafety(review)
	for (const reason of safety.reasons) deps.report.push(`   ${reason}`)
	if (!safety.safe) {
		deps.report.push(`   🔴 SAFETY BLOCKED (score: ${safety.score}/10)`)
		// COUNTED, because this arm used to be invisible: a block is not an
		// `[INFRA]` failure, so nothing was written and the identical block
		// recurred every five minutes indefinitely.
		//
		// COUNTED TWICE, on purpose, and the two numbers answer different
		// questions. `attempts` is the unbounded diagnostic every arm writes —
		// it is what lets a human see "attempt 47" and go look. `safety_block_runs`
		// is the bounded rule, because this gate is the ONE arm that cannot
		// retry its way to a different answer: `stepReview` only fetches a new
		// body when it finds none, so while a review exists the same bytes are
		// scored every tick, and `analyzeReviewSafety` is deterministic. A
		// tally that only climbs is a log, not a rule — mcpedia#48 printed the
		// identical 0/10 forever with `attempt 3` next to it and nothing acted.
		//
		// `noteFailure` is called on the RETRY arm only, not here. It prints
		// "retrying next tick", and printing that on the same tick that closes
		// the PR would contradict the line directly below it.
		const runs = bumpSafetyBlock(c.fixState, c.repo, c.prNum, c.headSha)
		persist(deps, c.fixState)
		c.out.skipped = true
		if (runs < SAFETY_BLOCK_CEILING) {
			await noteFailure(deps, c, `safety gate blocked the review (score ${safety.score}/10)`)
			persist(deps, c.fixState)
			deps.report.push(
				`   🔁 Safety gate refused this review (${runs}/${SAFETY_BLOCK_CEILING} at this SHA — retrying next tick)`,
			)
			return true
		}
		// THE CEILING. Nothing the worker can do between ticks changes this
		// verdict, so re-reading it a fourth time is the loop. Retire the PR
		// with the evidence attached; see `closeSafetyBlockedPr` for why a
		// close beats an unbounded wait here, and `SAFETY_BLOCK_CEILING` for
		// why the count is small.
		const why = `safety gate blocked the review (score ${safety.score}/10) ${runs}× at this SHA`
		if (deps.dry) {
			deps.report.push(`   🧪 dry run: would close #${c.prNum} (safety gate refused ${runs}×)`)
			return true
		}
		deps.report.push(`   ⛔ Safety gate refused ${runs}× — closing #${c.prNum} rather than looping`)
		const { status } = await closeSafetyBlockedPr(
			deps.api,
			c.token,
			c.repo,
			c.prNum,
			safety.reasons,
			runs,
			c.headSha,
		)
		if (status === 200) {
			// A `skip_reason` on top of the close, so a PR that is somehow
			// re-opened at the SAME head does not walk straight back into the
			// same four reads. Keyed on the head, so a new commit clears it.
			//
			// NOT paired with an explicit `notify("failed")`. The other two
			// close arms (`stepPinGuard`, the stale-CI close) notify nothing, and
			// `markSkip` is exactly the state that makes the NEXT tick send the
			// single `skipped` notice through `notifySkipOnce`. Calling notify
			// here as well would put two messages on the channel for one event.
			markSkip(c.fixState, c.repo, c.prNum, c.headSha, why)
			persist(deps, c.fixState)
			deps.report.push(`   ✅ Closed #${c.prNum} (safety gate refused ${runs}×)`)
		} else {
			// A failed close is NOT recorded as done: the next tick must be
			// able to try again, which is what leaving the tally at the ceiling
			// and the skip unwritten achieves.
			deps.report.push(`   ⚠️  Close failed HTTP ${status} — will retry next tick`)
		}
		return true
	}
	deps.report.push(`   ✅ Safety score: ${safety.score}/10`)
	c.score = safety.score

	const ci = await checkCiPassed(deps.api, c.token, c.repo, c.headSha)
	deps.report.push(`   🧪 CI: ${ci.msg}`)
	// An unreadable gate is not a green one, and it must stop BEFORE the stale
	// branch below — otherwise "we do not know" gets answered with a close.
	if (ci.unknown) {
		deps.report.push("   ⏳ CI unknown — not merging on an unverified gate; will retry next tick")
		// NOT counted. An unknown gate is transient by definition — GitHub 5xx,
		// a rate limit, a runner registering — and the whole point of this arm
		// is to wait it out. Counting it would pin a PR for a GitHub outage.
		c.out.skipped = true
		return true
	}
	if (ci.ok) return false

	// STALE-RED-CI DISPOSITION. MythEclipse's policy, 2026-10-16, and it INVERTS
	// what this arm used to do.
	//
	// A HUMAN PR that is broken, low-quality or harmful is DISPOSABLE: close it. A
	// DEPENDABOT bump must never be closed automatically — closing one is a silent
	// loss. The update vanishes with no trace, and nothing notices for two weeks,
	// until a later `pnpm audit` or the next Dependabot run trips over the gap. Those
	// get the AI fix instead, even at the cost of a long agent run: a breaking change
	// is still worth attempting, and a human is there to reject a bad result.
	//
	// So the previous wiring — `closeStaleCiPr` fired ONLY for dependabot, and a
	// human PR was only ever counted — had both cases exactly backwards.
	//
	// Both paths stay bounded, by different mechanisms:
	//   - human: a terminal close once the PR is older than the threshold, so a red
	//     CI stops being an infinite wait;
	//   - dependabot: unbounded counting with the agent offered again, because
	//     closing it is the one outcome that is worse than a slow queue.
	//
	// THE AGE GUARD IS THE SAFETY OF AUTO-CLOSING. A PR mid-review must not vanish
	// because CI is briefly red, so nothing is closed before the threshold.
	const staleAge = ageDays(c.createdAt, deps.now())
	const isDependabot = c.author === "dependabot[bot]"
	if (staleAge > STALE_CI_CLOSE_DAYS) {
		if (isDependabot) {
			// Reported, not closed. The worker is choosing the slow, recoverable
			// outcome over the silent one.
			deps.report.push(
				`   ⏳ CI failing ${staleAge.toFixed(1)}d on a dependency bump — NOT closing it, the agent will keep fixing it`,
			)
		} else {
			deps.report.push(`   ⛔ CI failing for ${staleAge.toFixed(1)}d — closing stale PR`)
			if (deps.dry) {
				deps.report.push(`   🧪 dry run: would close #${c.prNum} (stale failing CI)`)
				c.out.skipped = true
				return true
			}
			const { status } = await closeStaleCiPr(deps.api, c.token, c.repo, c.prNum, c.title, ci.msg)
			if (status === 200) {
				deps.report.push(`   ✅ Closed #${c.prNum} (stale failing CI)`)
				c.out.skipped = true
				return true
			}
			deps.report.push(`   ⚠️  Close failed HTTP ${status}`)
		}
	}
	deps.report.push("   ⏳ Waiting for green CI")
	// COUNTED FOR EVERY AUTHOR. This used to be dependabot-only, on the reasoning
	// that a human PR's red CI is fixed by the author pushing — true, and the head
	// SHA moving is the signal to retry. But leaving the counter unwritten made the
	// arm INVISIBLE: a human PR whose CI never recovers printed
	// `⏳ Waiting for green CI` on every tick forever with no state, no tally, and
	// nothing to grep for. That is the same "no rules" gap the `attempts` field's
	// doc comment records for GMW#109, left untouched for the author the worker is
	// least likely to be watching.
	//
	// Counting costs nothing here. It is a diagnostic with no ceiling and nothing
	// reads it to decide whether to give up — so a mid-push author is unaffected,
	// and a genuinely stuck PR becomes answerable ("attempt 40") instead of merely
	// slow.
	//
	// Still NOT a skip. See `isTransientInfra`: a `skip_reason` is enforced "until
	// head SHA changes", and for red CI the fix IS a head move, so a pin would be
	// the permanent stall fixed on 2026-10-15.
	await noteFailure(deps, c, `CI still red: ${ci.msg}`)
	c.out.skipped = true
	return true
}

// ── STEP E — approve + merge (2110-2170) ────────────────────────────────────

/**
 * The cause of a RETRYABLE merge failure — GitHub's own 5xx, or no answer at
 * all (`0`) — or `null` when the answer is a refusal the next tick cannot fix.
 */
const transientMergeCause = (status: number): string | null => {
	if (status === 0) return "no response from GitHub"
	return status >= 500 ? `GitHub HTTP ${status}` : null
}

/**
 * Re-read mergeability IMMEDIATELY before publishing an approval.
 *
 * WHY THIS GATE EXISTS. `stepMerge` used to approve first and merge second, and
 * `mergeable` had been read ONCE — during the queue scan, seconds earlier. GitHub
 * computes mergeability asynchronously and returns `null` while it does, so the
 * scan-time value is frequently stale or unknown. Two PRs were approved and then
 * refused on 2026-10-15 (hub#46, pr-agent-server#5) and the report blamed branch
 * protection, which neither repo had.
 *
 * An approval is the expensive half of this step: it is a PUBLIC, ATTRIBUTED
 * review on the PR that survives the failed merge. Merging is idempotent and
 * cheap to retry; endorsing a PR that cannot merge is not, and no later fix to a
 * message undoes it. So the check runs before the irreversible action, not after.
 *
 * `null` is the case that matters most. It means "GitHub is still computing",
 * NOT "no conflicts" — the pipeline's own `c.mergeable === false` test already
 * treats null as non-conflicting for Python parity, but that is safe for
 * deciding whether to ATTEMPT a merge and unsafe for deciding whether to
 * PUBLISH an endorsement. Unknown is reported as unknown and left for a later
 * tick.
 *
 * @returns a line to report and stop on, or `null` to proceed to approve+merge.
 */
async function mergeableGate(deps: WorkerDeps, c: Ctx): Promise<boolean> {
	const fresh = await refetchHead(deps, c)
	const pr = fresh as { mergeable?: unknown; mergeable_state?: unknown } | null
	const state = strOf(pr?.mergeable_state)

	// `false` is a definitive conflict answer, so it goes straight to the
	// conflict resolver — the same treatment the scan-time check gives it.
	if (pr?.mergeable === false) {
		deps.report.push(
			`   🔴 Merge conflicts${state ? ` (mergeable_state: ${state})` : ""} — resolving before approving`,
		)
		await resolveConflict(
			deps,
			c,
			alreadyFixed(c.fixState, c.repo, c.prNum, c.headSha),
			"   🔄 Head SHA updated (conflict fix pushed)",
			true,
		)
		return true
	}

	// `null` means GitHub has not finished computing. Approving on an unknown is
	// the failure this whole gate exists to prevent, so the tick ends here and
	// the next one — seconds later — gets a real answer.
	if (pr?.mergeable === null || pr?.mergeable === undefined) {
		deps.report.push(
			"   ⏳ Mergeability still computing — not approving on an unknown, retrying next tick",
		)
		await noteFailure(deps, c, "mergeability unknown (GitHub still computing)")
		return true
	}

	return false
}

/** True when the PR merged. */
export async function stepMerge(deps: WorkerDeps, c: Ctx, already: boolean): Promise<boolean> {
	const url = `https://github.com/${c.repo}/pull/${c.prNum}`

	// BEFORE the approval, not after the merge attempt: an approval is a public,
	// attributed review that outlives a failed merge, so the irreversible action
	// is the one that must be gated.
	if (await mergeableGate(deps, c)) {
		c.out.skipped = true
		return false
	}

	deps.report.push("   👍 Approving...")
	if (deps.dry) {
		deps.report.push(`   🧪 dry run: would approve and merge #${c.prNum}`)
		return false
	}
	const approveStatus = await approvePr(deps.api, c.token, c.repo, c.prNum)
	deps.report.push(
		approveStatus === 200 || approveStatus === 201
			? "   ✅ Approved!"
			: `   ⚠️  Approve: HTTP ${approveStatus}`,
	)

	deps.report.push("   🔀 Merging...")
	const { status, data } = await mergePr(
		{ fetchGhToken: deps.fetchGhToken },
		deps.api,
		c.token,
		c.repo,
		c.prNum,
		c.headSha,
	)
	if (status === 200) {
		deps.report.push(`   ✅ MERGED! SHA: ${data?.sha ?? "?"}`)
		await deps.notify(c.repo, c.prNum, "done", `PR merged (${c.title})`, c.score, url)
		return true
	}
	if (status === 405) {
		// A 405 does NOT mean branch protection. GitHub returns it for two
		// genuinely different reasons, and this report used to assert the wrong
		// one unconditionally: `mergeable_state: "dirty"` (real conflicts) and an
		// unsatisfied required-check rule. On 2026-10-15 hub#46 and
		// pr-agent-server#5 were both reported "⚠️  Branch protection blocks
		// merge" while BOTH repos had no protection and no rulesets at all —
		// `GET /branches/main/protection` was 404. The real cause was a stale
		// conflict, and the message pointed a human at the one thing that was
		// not wrong.
		//
		// `mergeable_state` is readable BEFORE merging and is the field that
		// actually separates the cases: `dirty` = conflicts, `blocked` = policy
		// (required reviews / required checks), `behind` = base moved,
		// `unstable` = a non-required check is failing.
		//
		// So read it back and report what it says. `mergeable_state` is `null`
		// while GitHub computes, which is why the unknown case is named instead
		// of guessed.
		const fresh = await refetchHead(deps, c)
		// `refetchHead` returns `any | null`, narrowed by an inline shape rather
		// than an `asObject` helper this module does not have.
		const ms = strOf((fresh as { mergeable_state?: unknown } | null)?.mergeable_state)
		deps.report.push(
			ms === "dirty"
				? "   ⚠️  Merge refused — merge CONFLICTS (mergeable_state: dirty)"
				: ms === "blocked"
					? "   ⚠️  Branch protection blocks merge (mergeable_state: blocked)"
					: ms === "unstable"
						? "   ⚠️  Merge refused — a check is failing (mergeable_state: unstable)"
						: ms === "behind"
							? "   ⚠️  Merge refused — base branch moved (mergeable_state: behind)"
							: `   ⚠️  Merge refused HTTP 405 (mergeable_state: ${ms || "unknown"})`,
		)
		// Counted: a 405 is a standing refusal that no retry can clear on its
		// own, so without a tally this line repeats forever. A repo-side rule
		// change does NOT move the head SHA — which is exactly why this needed
		// counting and not just "retry until the head moves".
		await noteFailure(deps, c, `merge refused HTTP 405 (${ms || "mergeable_state unknown"})`)
		return false
	}
	if (status === 409) {
		// GitHub said mergeable and then refused — a stale `mergeable` read. Same
		// one-attempt resolve as the 2066 gate, and equally not retried.
		deps.report.push("   ⚠️  Merge conflict")
		await resolveConflict(deps, c, already, "   🔄 Will re-merge next tick after CI settles", false)
		return false
	}
	// An outage is not a refusal: the next tick retries it, so calling this a
	// failed review — what GitHub's 2026-10-07 incident produced four times over —
	// would tell the operator that work was rejected when nothing was decided.
	const cause = transientMergeCause(status)
	if (cause) {
		deps.report.push(`   ⚠️  Merge deferred: ${cause} — will retry next tick`)
		await deps.notify(
			c.repo,
			c.prNum,
			"retry",
			`Merge deferred: ${cause} (transient) — will retry next tick`,
			c.score,
			url,
		)
		return false
	}
	deps.report.push(`   ⚠️  Merge: HTTP ${status}`)
	// Counted. A 4xx that is not 405/409 is a standing refusal — a bad merge
	// method, a missing permission, a draft PR — and none of those clear by
	// trying again. The head SHA cannot move for any of them, so this arm would
	// report the same HTTP status on every tick forever.
	await noteFailure(deps, c, `merge refused with HTTP ${status}`)
	await deps.notify(
		c.repo,
		c.prNum,
		"failed",
		`Merge failed HTTP ${status}: ${data?.message ?? ""}`,
		c.score,
		url,
	)
	return false
}
