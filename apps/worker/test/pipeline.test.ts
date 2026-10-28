// biome-ignore-all lint/suspicious/noExplicitAny: test fakes stand in for untyped GitHub payloads
// biome-ignore-all lint/style/noNonNullAssertion: test asserts immediately after each non-null use
/**
 * Per-PR decision pipeline + tick runner — the task-14 brief's 7 required test
 * cases, ported from `scripts/pr-queue-worker.py` lines 1833-2186 (`main`) and
 * the CLI block at 2200-2225.
 *
 * HERMETIC BY CONSTRUCTION, like the other worker suites: the GitHub client is
 * a route table, the agent is a counter, git is an argv table, the workdirs fs
 * is a Map, the process effects are no-ops and the state files are plain
 * objects. No test opens a socket, spawns a process, or writes to
 * `/tmp/pr-queue-*` — except `lockReleaseOnThrow`, which deliberately drives the
 * REAL `WorkerLock` against a `mkdtemp` path, because "the lock comes back" is
 * exactly the property a fake cannot prove.
 *
 * THE SEVEN CASES, one `describe` each, numbered as the brief numbers them.
 * The two that carry real risk get the extra assertions that make them risky:
 *   - case 4 proves "the next tick does not re-call the agent" by RUNNING THE
 *     TICK TWICE against one shared fix state, not by inspecting state;
 *   - case 7 pins the permanent-skip reason to the Python's exact string.
 *
 * On top of the seven, four extra tests hold the things the brief states in
 * prose rather than as a case: the summary-line format, `mergeable: null` NOT
 * being the conflict branch (Python's `is False`), the 409 conflict arm, and the
 * lock being released when the tick throws.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { PostResult } from "../src/claude-agent.ts"
import type { GitResult, GitRunner } from "../src/git.ts"
import { WorkerLock } from "../src/lock.ts"
import { AI_FIX_BUDGET_CEILING, AI_FIX_RETRY_CEILING } from "../src/pr/context.ts"
import type { ProcRunner, Workdirs } from "../src/pr/lockfix.ts"
import { SWEEP_MIN_AGE_HOURS, sweepPromptAudits, sweepStaleWorkdirs } from "../src/pr/lockfix.ts"
import { processPr, runTick, UNRESOLVABLE_CONFLICT, type WorkerDeps } from "../src/pr/pipeline.ts"
import type { FetchLike } from "../src/pr/review.ts"
import type { GhAppClient } from "../src/pr/scan.ts"
import type { FixState } from "../src/state.ts"
import type { SyncState } from "../src/sync/config.ts"

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const REPO = "acme/widgets"
const PR_NUM = 7
const HEAD = `${"a1b2c3d4e5f6".repeat(3)}abcd` // 40 hex chars

/** Python's `strptime("%Y-%m-%dT%H:%M:%SZ")` shape, no milliseconds. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z")

/** A review the Python's own `analyze_review_safety` scores 10/10. */
const SAFE_REVIEW = [
	"## PR Reviewer Guide 🔍",
	"⏱️ Estimated effort to review: 1 🔵⚪⚪⚪⚪",
	"🏅 Score: 100",
	"🔒 No security concerns identified",
	"⚡ No major issues detected",
	"🧪 No relevant tests",
].join("\n")

const BOT = "mytheclipsebotreview[bot]"

/** The `## PR Reviewer Guide` comment shape `findReviewComment` matches. */
const reviewComment = (body: string) => ({ user: { login: BOT }, body })

/**
 * Python lines 1912-1923: a dependabot lockfile bump PR-Agent already assessed
 * as having nothing to review.
 *
 * THIS FIXTURE IS HOW A TEST REACHES THE CONFLICT RESOLVER WITH EXACTLY ONE
 * AGENT CALL, and the reason is a real property of the Python rather than a
 * test convenience. `no_code_review` skips STEP B wholesale (line 1952), while
 * the resolver's gate is only `AI_FIX_ENABLED and not already` (line 2071) —
 * so the resolve runs where the ordinary AI fix did not. The alternative
 * suppression, a seeded `already` (line 1989), would suppress the resolve too,
 * and the only other way to stop the AI fix is to let it run — which is a
 * SECOND agent call before the resolve ever happens.
 */
const NO_CODE_MARKER = {
	user: { login: BOT },
	body: "## PR Code Suggestions\nNo code suggestions found (dependency/lockfile-only bump).",
}

/** The trivial title `isTrivialPr` needs, with the author the resolver skips on. */
const LOCKFILE_BUMP = {
	title: "chore(deps): bump axios from 1.6.0 to 1.7.0",
	user: { login: "dependabot[bot]" },
}

/** Only the SKIP notices, per the brief's "notifyReview (skip) terkirim sekali". */
const skipNotices = (h: { notifies: Notify[] }): Notify[] =>
	h.notifies.filter((n) => n.status === "skipped")

function makePr(over: Record<string, any> = {}): any {
	return {
		number: PR_NUM,
		title: "Refactor: harden the parser",
		state: "open",
		merged: false,
		head: { sha: HEAD, ref: "feature/harden" },
		base: { ref: "main" },
		user: { login: "alice" },
		mergeable: true,
		created_at: iso(Date.now() - 3600_000),
		...over,
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════════════════════

type Call = { method: string; path: string; json?: unknown }
type Notify = {
	repo: string
	pr: number
	status: string
	summary: string
	score: string | number
	url: string
}
type Route = { status: number; data: any }

type Options = {
	/** The open PRs `gatherOpenPrs` will hand back. */
	prs?: any[]
	/** `GET /repos/:r/issues/:n/comments` body. */
	comments?: any[]
	/** `GET /repos/:r/commits/:s/check-runs` body. */
	checkRuns?: any[]
	/** The repo `GET /repos/:r` reports (used by the sync fan-out). */
	repoMeta?: Route
	/** `repoHasBunLock` reads `GET /repos/:r/git/trees/:s?recursive=1` and looks for
	 *  a `bun.lock` entry; the harness serves a Bun tree by default. Set false for
	 *  a repo with no `bun.lock` (a uv repo) — see the `stepLockPrefix` matrix. */
	hasBunLock?: boolean
	/** `runAiFix`'s verdict, in call order; the last one repeats. */
	agent?: PostResult[]
	/** Fixed `now()`, in seconds; a tick reads it for elapsed + sync. */
	nowSec?: number
	/** Pre-seeded fix state — the case-3 permanent skip. */
	fixState?: FixState
	/** Throw from `request` on the pulls path, to fail a tick mid-flight. */
	throwOn?: (path: string) => boolean
	/** `POST /pulls/:n/merge` reply. */
	merge?: Route
	/** `GET /repos/:r/commits/:s/check-runs` reply — set it to a non-200 to
	 *  model an API that cannot answer the gate. */
	checkRunsReply?: Route
	/** `GET /pulls/:n` (the re-validation + head re-fetch) reply. */
	pullReply?: Route
	/**
	 * Sequential `GET /pulls/:n` replies, consumed in call order with the last
	 * one repeating. `checkPrStillValid` reads the PR BEFORE the agent runs and
	 * `refetchHead` reads it AFTER, so a single static reply cannot express
	 * "unchanged going in, moved coming out" — which is exactly the shape a
	 * successful fix produces.
	 */
	pullReplySeq?: Route[]
	/**
	 * What `git rev-parse HEAD` reports after the fix's push — i.e. the commit
	 * the fix actually landed. Empty by default, so every pre-existing case keeps
	 * its old behaviour (the record falls back to the pre-push head).
	 */
	pushedSha?: string
	/** `--dry`: start the deps in dry mode, so the effects are suppressed. */
	dry?: boolean
}

type Harness = {
	deps: WorkerDeps
	/** Every GitHub call, in order. */
	calls: Call[]
	/** The `agent.post` prompts, in order — the "was the agent called?" oracle. */
	agentPosts: { prompt: string }[]
	/** `notifyReview` payloads, in order. */
	notifies: Notify[]
	/** Argv the lockfix `exec` port saw — must stay empty in every case here. */
	execCalls: string[][]
	fixState: FixState
	/** How many times the tick/runner asked for the lock. */
	lockCalls: number
	/** Lines pushed to the report port, in order. */
	lines: string[]
}

function harness(opts: Options = {}): Harness {
	const calls: Call[] = []
	const agentPosts: { prompt: string }[] = []
	const notifies: Notify[] = []
	const execCalls: string[][] = []
	const prs = opts.prs ?? []
	const comments = opts.comments ?? []
	const checkRuns = opts.checkRuns ?? [
		{ name: "build", status: "completed", conclusion: "success" },
	]
	const repoMeta = opts.repoMeta ?? {
		status: 200,
		data: { full_name: REPO, fork: false, default_branch: "main" },
	}
	const merge = opts.merge ?? { status: 200, data: { sha: "c0ffee" } }
	const checkRunsReply = opts.checkRunsReply
	const pullReply = opts.pullReply
	const pullReplySeq = [...(opts.pullReplySeq ?? [])]
	let pullCall = 0
	const agentReplies = [...(opts.agent ?? [{ ok: true, snippet: "done" }])]
	const fixState: FixState = opts.fixState ?? {}
	let agentCall = 0

	const api: GhAppClient = {
		async request(method, path, o = {}) {
			calls.push({ method, path, json: o.json })
			if (opts.throwOn?.(path)) throw new Error("boom")
			if (path.startsWith("/app/installations")) return { status: 200, data: [{ id: 1 }] }
			if (path.startsWith("/installation/repositories")) {
				return { status: 200, data: { repositories: [{ full_name: REPO }] } }
			}
			if (/\/pulls\?/.test(path)) return { status: 200, data: prs }
			if (path === `/repos/${REPO}`) return repoMeta
			if (/\/issues\/\d+\/comments$/.test(path)) return { status: 200, data: comments }
			if (/\/check-runs$/.test(path))
				return checkRunsReply ?? { status: 200, data: { check_runs: checkRuns } }
			if (/\/git\/trees\/.*recursive/.test(path)) {
				const tree =
					opts.hasBunLock === false
						? [{ path: "package.json" }, { path: "uv.lock" }]
						: [{ path: "package.json" }, { path: "bun.lock" }]
				return { status: 200, data: { tree } }
			}
			if (/\/pulls\/\d+\/merge$/.test(path)) return merge
			if (/\/pulls\/\d+$/.test(path)) {
				// `pullReplySeq` when the test needs the head to move between the
				// pre-agent check and the post-push re-fetch; else the static reply.
				if (pullReplySeq.length) {
					return pullReplySeq[Math.min(pullCall++, pullReplySeq.length - 1)]
				}
				return (
					pullReply ?? {
						status: 200,
						data: { state: "open", merged: false, head: { sha: HEAD }, mergeable: true },
					}
				)
			}
			return { status: 200, data: {} }
		},
		async installationToken() {
			return "install-token"
		},
	}

	const agent = {
		async post(prompt: string): Promise<PostResult> {
			agentPosts.push({ prompt })
			const reply = agentReplies[Math.min(agentCall, agentReplies.length - 1)]
			agentCall += 1
			return reply
		},
		async runSync(): Promise<PostResult> {
			return { ok: true, snippet: "sync" }
		},
	}

	// Only the verbs `runAiFix` issues; anything else is a bug in the wiring.
	const run: GitRunner = (args): GitResult => {
		switch (args[0]) {
			case "clone":
				return { code: 0, stdout: "", stderr: "" }
			case "diff":
				return { code: 0, stdout: "src/parser.ts\n", stderr: "" }
			case "rev-list":
				return { code: 0, stdout: "1\n", stderr: "" }
			case "rev-parse":
				// The pushed tip `runAiFix` reads back after a successful push.
				return { code: 0, stdout: opts.pushedSha ? `${opts.pushedSha}\n` : "", stderr: "" }
			case "push":
				return { code: 0, stdout: "", stderr: "" }
			default:
				return { code: 0, stdout: "", stderr: "" }
		}
	}

	const files = new Map<string, string>()
	const workdirs: Workdirs = {
		exists: (p) => files.has(p) || p === "/tmp/pr-queue-pids",
		mkdir: () => {},
		remove: (p) => void files.delete(p),
		writeFile: (p, c) => void files.set(p, c),
		readFile: (p) => files.get(p) ?? "",
	}

	const exec: ProcRunner = (args) => {
		execCalls.push(args)
		return { code: 0, stdout: "", stderr: "" }
	}

	const fetchImpl: FetchLike = async () => ({ status: 200 })

	const lines: string[] = []
	const report = { push: (line: string) => void lines.push(line) }

	let lockCalls = 0
	const deps: WorkerDeps = {
		api,
		agent,
		run,
		exec,
		workdirs,
		procs: { workdirs, procExists: () => false, kill: () => {}, sleep: () => {}, pid: 4242 },
		fetchGhToken: () => "gh-pat",
		report,
		flushReport: () => Promise.resolve(),
		notify: (
			repo: string,
			pr: number,
			status: string,
			summary: string,
			score: string | number,
			url: string,
		) => {
			notifies.push({ repo, pr, status, summary, score, url })
			return Promise.resolve()
		},
		postDiscord: () => Promise.resolve(true),
		loadFixState: () => fixState,
		saveFixState: () => {},
		loadSyncState: (): SyncState => ({}),
		saveSyncState: () => {},
		repoOverrides: {},
		now: () => opts.nowSec ?? 1_700_000_000,
		fetchImpl,
		lock: {
			acquire: () => {
				lockCalls += 1
				return { release: () => {} }
			},
		},
		dry: opts.dry ?? false,
	}

	return { deps, calls, agentPosts, notifies, execCalls, fixState, lockCalls, lines }
}

const approves = (calls: Call[]): number =>
	calls.filter((c) => c.method === "POST" && c.path.endsWith("/reviews")).length
const merges = (calls: Call[]): number =>
	calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge")).length
const closes = (calls: Call[]): Call[] =>
	calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/pulls/${PR_NUM}`))
const ctx = { token: "install-token", repo: REPO, pr: makePr() }

// ═══════════════════════════════════════════════════════════════════════════

describe("case 1 — a PR with no review triggers one and stops for this tick", () => {
	test("triggered, nothing merged, not even counted as skipped", async () => {
		const h = harness({ prs: [makePr()] })

		const out = await processPr(h.deps, ctx)

		expect(out).toEqual({ merged: false, triggered: true, fixed: false, skipped: false })
		expect(approves(h.calls)).toBe(0)
		expect(merges(h.calls)).toBe(0)
		expect(h.agentPosts).toEqual([])
		expect(h.lines).toContain("   📡 No review → triggering PR-Agent...")
		// The wording changed on 2026-10-28 and the change is the point. It used to
		// read "PR-Agent triggered", which claimed a review had HAPPENED when the
		// 200 only means the request was enqueued. That line printed every five
		// minutes for hours while the reviewer was dying server-side with a 403
		// and posting nothing — the queue's own report was the reason nobody
		// noticed. The report now says what is actually true: accepted, awaiting.
		expect(h.lines).toContain("   ✅ PR-Agent accepted the request (HTTP 200) — awaiting the review")
		// Python `continue`s at line 1934 WITHOUT touching skipped_count, which the
		// `toEqual` above already pins. An extra negative assertion here would be
		// tautological: that conflict line is only reachable from the resolver,
		// which needs a review to exist and this PR has none.
	})

	test("an accepted request with no review next tick is reported, not re-triggered", async () => {
		// The 2026-10-28 failure, as a test: the trigger returns 200, but no review
		// comment ever appears. Before the fix the second tick printed another
		// green "triggered" line and fired yet another doomed request, so a broken
		// reviewer looked identical to a healthy one from the report alone.
		const h = harness({ prs: [makePr()] })
		await processPr(h.deps, ctx) // tick 1: requests the review, records the request
		const before = h.lines.length

		const out = await processPr(h.deps, ctx) // tick 2: still no review comment
		const second = h.lines.slice(before)

		expect(second).toContain("   ⚠️  Review requested 1× at this SHA, no review after 0m")
		expect(second.some((l) => l.includes("never posted a review"))).toBe(true)
		// NOT re-fired yet: 0m have passed, and a review that is merely slow has
		// not had its chance. Firing here would double-pay for it.
		expect(second).not.toContain("   📡 No review → triggering PR-Agent...")
		expect(out.triggered).toBe(false)
		// Counted as skipped, so the queue's own summary admits the PR is waiting
		// on something rather than silently doing nothing.
		expect(out.skipped).toBe(true)
	})

	test("a review still missing after the wait is re-fired once, then given up on", async () => {
		// A job that dies server-side leaves no trace on the PR. Waiting forever
		// means one transient failure parks the PR permanently, which is the
		// "stuck" complaint this fixes — so one recovery attempt is allowed after
		// a wait no healthy review would exceed.
		const h = harness({ prs: [makePr()] })
		await processPr(h.deps, ctx) // tick 1: request accepted

		// 16 minutes later: the recovery re-fire. `deps.now` is reassigned rather
		// than rebuilt because the recorded request lives in the harness's fixState
		// — a fresh harness would have no request to be late for.
		const base = h.deps.now()
		;(h.deps as any).now = () => base + 16 * 60 * 1000
		const before = h.lines.length
		const out = await processPr(h.deps, ctx)
		const second = h.lines.slice(before)
		expect(second.some((l) => l.includes("re-triggering once"))).toBe(true)
		expect(second).toContain("   📡 No review → triggering PR-Agent...")
		expect(out.triggered).toBe(true)

		// An hour later: the second attempt also failed, so it stops. The bound is
		// what makes this a recovery and not an infinite money leak.
		;(h.deps as any).now = () => base + 60 * 60 * 1000
		const before3 = h.lines.length
		const out3 = await processPr(h.deps, ctx)
		const third = h.lines.slice(before3)
		expect(third.some((l) => l.includes("never posted a review"))).toBe(true)
		expect(third).not.toContain("   📡 No review → triggering PR-Agent...")
		expect(out3.triggered).toBe(false)
		expect(out3.skipped).toBe(true)
	})

	test("a non-2xx trigger is reported verbatim and still not 'triggered'", async () => {
		const h = harness({ prs: [makePr()] })
		;(h.deps as any).fetchImpl = async () => ({ status: 500 })

		const out = await processPr(h.deps, ctx)

		expect(out.triggered).toBe(false)
		expect(h.lines).toContain("   ⚠️  Trigger result: 500")
	})
})

describe("attempt tally — failures are recorded, never written off", () => {
	// The failure this pins is not a bug in any one gate; it is the ABSENCE of a
	// rule. `skip_reason` was only ever written for `[INFRA]` failures, so an
	// ordinary one — a blocked safety review, a standing merge refusal — left no
	// state at all, and the next tick saw an untouched PR and did the identical
	// expensive work. GMW#109 sat that way for days, printing the identical
	// block every five minutes.
	//
	// What is recorded is a DIAGNOSTIC. A PR that cannot be fixed stays in the
	// queue and is retried until it can — an earlier version pinned it after
	// three attempts and called that escalation, which is a permanent stall, the
	// exact opposite of what was wanted.

	/** A review the gate refuses: a real security finding. */
	const BLOCKED_REVIEW = [
		"## PR Reviewer Guide 🔍",
		"⏱️ Estimated effort to review: 1 🔵⚪⚪⚪⚪",
		"🔒&nbsp;<strong>Security concerns</strong><br><br>",
		"",
		"SQL injection in src/auth.ts",
		"</td></tr>",
	].join("\n")

	// `attempt_sha`, NOT `sha`. A failure tally is keyed on its own field:
	// `sha` is what `alreadyFixed` reads as "the fix landed here", so a state
	// file that records a failure under `sha` claims the PR is DONE. That
	// conflation is what `bumpAttempt` used to write, and it silently suppressed
	// every retry. Seeded with the real key so the fixture cannot drift back.
	//
	// `attempts <= 0` means NEVER TRIED, so the key is omitted: `bumpAttempt`
	// counts from `attempts ?? 0`, and seeding a literal 0 would make the first
	// real failure report "attempt 1" for a PR the fixture is asserting is being
	// skipped entirely (the CI-unknown arm records nothing at all).
	const stateFor = (attempts: number): FixState => ({
		[REPO]: {
			[String(PR_NUM)]: attempts > 0 ? { attempt_sha: HEAD, attempts } : {},
		},
	})

	test("a blocked safety gate counts the attempt and keeps retrying", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(BLOCKED_REVIEW)],
			fixState: stateFor(1),
		})
		await processPr(h.deps, ctx)

		expect(h.lines).toContain("   🔴 SAFETY BLOCKED (score: 0/10)")
		// A blocked gate is recorded, and the report says so.
		expect(h.lines.some((l) => l.includes("🔁"))).toBe(true)
		// The gate's own tally starts from the seeded 1, because the agent run
		// above it SUCCEEDED — `markFixed` cleared the tally and the gate is the
		// failure being counted. It was 2 before only because recording the
		// attempt used to claim the head as fixed, which short-circuited the
		// agent; with that conflation gone the number is earned, not inherited.
		expect(h.fixState[REPO][String(PR_NUM)].attempts).toBe(1)
	})

	test("a high attempt count is NEVER converted into a give-up", async () => {
		// The policy correction. Fifty failures at one head is a PR that needs a
		// human — but the worker's job is to keep trying, not to declare it
		// hopeless, because "hopeless" is exactly what a fixable-but-blocked PR
		// looks like before its bug is found. It must stay in the queue.
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(BLOCKED_REVIEW)],
			fixState: stateFor(50),
		})
		await processPr(h.deps, ctx)

		expect(h.fixState[REPO][String(PR_NUM)].skip_reason).toBeUndefined()
		// Still counted, still not escalated, and the count survives as a
		// diagnostic. The exact value is 1 because the seeded 50 belongs to the
		// agent phase, which `markFixed` reset — the point of this test is the
		// ABSENCE of a pin, not the tally.
		expect(h.fixState[REPO][String(PR_NUM)].attempts).toBe(1)
		// No "Unresolvable" pin, and no skip notification claiming one.
		expect(h.lines.some((l) => l.includes("Unresolvable"))).toBe(false)
		expect(skipNotices(h).length).toBe(0)
	})

	test("a blocked human PR is counted like any other", async () => {
		// The guard counts every failure; what it must never DO is use that count
		// to close off the PR. Three failures across three real attempts still
		// leaves it open and retryable.
		const h = harness({
			prs: [makePr({ user: { login: "asepharyana" } })],
			comments: [reviewComment(BLOCKED_REVIEW)],
			fixState: stateFor(0),
		})
		await processPr(h.deps, ctx)
		expect(h.fixState[REPO][String(PR_NUM)].skip_reason).toBeUndefined()
		expect(h.fixState[REPO][String(PR_NUM)].attempts).toBe(1)
	})

	test("branch protection is counted too — a rule change moves no SHA", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: stateFor(0),
			merge: { status: 405, data: {} },
			// `mergeable_state: blocked` is what an unsatisfied required-check or
			// required-review rule actually looks like. It is what the 405 arm now
			// reads back instead of asserting a cause it cannot see.
			pullReply: { status: 200, data: makePr({ mergeable_state: "blocked" }) },
		})
		await processPr(h.deps, ctx)

		expect(h.lines).toContain("   ⚠️  Branch protection blocks merge (mergeable_state: blocked)")
		// Counted for visibility, never escalated: the fix is a repo-side rule
		// change, and until it lands the honest state is "still trying".
		expect(h.fixState[REPO][String(PR_NUM)].attempts).toBe(1)
		expect(h.fixState[REPO][String(PR_NUM)].skip_reason).toBeUndefined()
	})

	test("a 405 from merge CONFLICTS is not reported as branch protection", async () => {
		// The live bug. hub#46 and pr-agent-server#5 were both printed as
		// "⚠️  Branch protection blocks merge" while NEITHER repo had any
		// protection or ruleset at all — `GET /branches/main/protection` was a
		// 404. The real cause was `mergeable_state: "dirty"`, i.e. a stale
		// conflict, so the message sent a human after the one thing that was not
		// broken. A 405 alone cannot tell the two apart; `mergeable_state` can.
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: stateFor(0),
			merge: { status: 405, data: {} },
			pullReply: { status: 200, data: makePr({ mergeable_state: "dirty" }) },
		})
		await processPr(h.deps, ctx)

		expect(h.lines.some((l) => l.includes("merge CONFLICTS"))).toBe(true)
		// The specific misdiagnosis must be gone, not merely supplemented.
		expect(h.lines.some((l) => l.includes("Branch protection"))).toBe(false)
		// Still counted — a conflict is retryable, so it is a standing refusal
		// here, but never escalated.
		expect(h.fixState[REPO][String(PR_NUM)].attempts).toBe(1)
		expect(h.fixState[REPO][String(PR_NUM)].skip_reason).toBeUndefined()
	})

	test("a 405 with no readable mergeable_state names the ambiguity", async () => {
		// GitHub reports `mergeable_state: null` while it computes. Guessing
		// "branch protection" there is exactly the original defect, so the
		// unknown case is stated rather than invented.
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: stateFor(0),
			merge: { status: 405, data: {} },
			pullReply: { status: 200, data: makePr({ mergeable_state: null }) },
		})
		await processPr(h.deps, ctx)

		expect(h.lines.some((l) => l.includes("Merge refused HTTP 405"))).toBe(true)
		expect(h.lines.some((l) => l.includes("unknown"))).toBe(true)
		expect(h.lines.some((l) => l.includes("Branch protection"))).toBe(false)
	})

	test("CI unknown is not counted — a transient outage must not accumulate", async () => {
		// The arm that must NOT record a retry. A 5xx or rate-limited gate is
		// transient by definition; counting it would inflate the tally of every
		// PR in the queue during a GitHub incident and make a healthy queue look
		// stuck.
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: stateFor(0),
			checkRunsReply: { status: 500, data: {} },
		})
		await processPr(h.deps, ctx)

		expect(h.lines.some((l) => l.includes("CI unknown"))).toBe(true)
		// Recorded as NOTHING at all — not zero, absent. A 0 here would mean the
		// gate was consulted and found clean; `undefined` means never tried.
		expect(h.fixState[REPO][String(PR_NUM)].attempts).toBeUndefined()
	})
})

describe("case 2 — review + clean safety + green CI + mergeable merges once", () => {
	test("merged, with exactly one approve and one merge", async () => {
		// `already` short-circuits the AI-fix block: this case is about the merge
		// decision, and the line proves why the agent was not called.
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD, notified: false } } },
		})

		const out = await processPr(h.deps, ctx)

		expect(out).toEqual({ merged: true, triggered: false, fixed: false, skipped: false })
		expect(approves(h.calls)).toBe(1)
		expect(merges(h.calls)).toBe(1)
		expect(h.agentPosts).toEqual([])
		expect(h.execCalls).toEqual([])

		expect(h.lines).toContain("   📝 Review found")
		expect(h.lines).toContain("   ⏭️  Already fixed at this SHA — skip AI fix")
		expect(h.lines).toContain("   ✅ Safety score: 10/10")
		expect(h.lines).toContain("   🧪 CI: ✅ 1 checks green")
		expect(h.lines).toContain("   👍 Approving...")
		expect(h.lines).toContain("   ✅ Approved!")
		expect(h.lines).toContain("   🔀 Merging...")
		expect(h.lines).toContain("   ✅ MERGED! SHA: c0ffee")
		expect(h.notifies.map((n) => n.status)).toEqual(["done"])
	})

	test("the merge sends the head sha as the pre-merge condition", async () => {
		const h = harness({
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } },
		})
		await processPr(h.deps, ctx)

		const put = h.calls.find((c) => c.method === "PUT" && c.path.endsWith("/merge"))
		expect(put?.json).toEqual({
			commit_title: `Auto-merge PR #${PR_NUM}`,
			merge_method: "merge",
			sha: HEAD,
		})
	})
})

describe("case 3 — a permanent skip at this SHA skips without calling the agent", () => {
	test("skipped, agent untouched, skip notified once", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: {
				[REPO]: {
					[String(PR_NUM)]: {
						sha: HEAD,
						skip_reason: "Claude Code not available",
						notified: false,
					},
				},
			},
		})

		const out = await processPr(h.deps, ctx)

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(h.agentPosts).toEqual([])
		expect(approves(h.calls)).toBe(0)
		expect(merges(h.calls)).toBe(0)
		expect(h.lines).toContain(
			"   ⏭️  Permanently skipped: Claude Code not available (until head SHA changes)",
		)
		// Python 1947 calls `notify_skip_once` as a bare statement: the notification
		// DOES fire (asserted below), but no `🔔 Skip notified` line is appended.
		// Only the three `if notify_skip_once(...):` sites report it — on those,
		// this line would appear in the ops channel on every single cron tick of
		// every permanently-skipped PR. Asserting its ABSENCE is the whole point.
		expect(h.lines).not.toContain("   🔔 Skip notified: Claude Code not available")
		expect(h.notifies).toEqual([
			{
				repo: REPO,
				pr: PR_NUM,
				status: "skipped",
				summary: "⏭️ Skipped: Claude Code not available — will not retry until the PR head changes",
				score: "",
				url: `https://github.com/${REPO}/pull/${PR_NUM}`,
			},
		])
	})
})

describe("case 4 — an agent run that exhausts its BUDGET is retried, then stops being offered", () => {
	// This case used to assert the opposite: a 1800s timeout was pinned as a
	// `skip_reason` and never retried. The cost it was protecting against is
	// real (1800s of a paid model per attempt) but the remedy was wrong — a pin
	// is enforced "until head SHA changes", and a timeout never moves a head.
	// Measured on hub#61 + pr-agent-server#27, both a `@moonrepo/cli@2.6.3` bump
	// whose platform binaries were never published: no edit could make CI green,
	// so both were pinned `Permanently skipped` after one 1800s run.
	//
	// The contract now has two halves, and both are asserted here:
	//   - the PR is NOT pinned (no `skip_reason`), so it stays releasable;
	//   - the spend IS bounded, at `AI_FIX_BUDGET_CEILING` runs per head.
	test("the timeout does not pin, and the agent stops being offered at the ceiling", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: false, snippet: "[INFRA] Claude Code timed out after 1800s" }],
		})

		const first = await runTick(h.deps)
		expect(h.agentPosts).toHaveLength(1)
		expect(first).toContain("   ⏭️  AI fix skipped: [INFRA] Claude Code timed out after 1800s")
		// NOT a pin: the whole point of the change.
		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBeUndefined()
		expect((h.fixState[REPO][String(PR_NUM)] as any).budget_runs).toBe(1)
		expect(first).toContain(
			`   🔁 Agent exhausted its budget (1/${AI_FIX_BUDGET_CEILING} at this SHA — retrying next tick)`,
		)
		// No skip notification, because nothing was skipped permanently.
		expect(skipNotices(h)).toHaveLength(0)

		// Retryable: the next tick on the SAME head offers the agent again.
		const second = await runTick(h.deps)
		expect(h.agentPosts).toHaveLength(2)
		expect(second).not.toContain("   ⏭️  Permanently skipped:")
		expect((h.fixState[REPO][String(PR_NUM)] as any).budget_runs).toBe(2)

		// Third run spends the budget, and the ceiling stops the fourth.
		await runTick(h.deps)
		expect(h.agentPosts).toHaveLength(3)
		const fourth = await runTick(h.deps)
		expect(h.agentPosts).toHaveLength(3)
		expect(fourth).toContain(
			`   ⏭️  Agent budget spent ${AI_FIX_BUDGET_CEILING}× at this SHA — leaving it to the CI gate (not a skip)`,
		)
		// Still not a pin — the PR remains eligible the moment CI goes green.
		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBeUndefined()
	})

	test("a NEW head sha resets the budget tally", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: false, snippet: "[INFRA] Claude Code timed out after 1800s" }],
		})
		await runTick(h.deps)
		expect(h.agentPosts).toHaveLength(1)

		// Same PR, new head — a new head is new work and must not inherit the
		// previous head's spend.
		h.deps.loadFixState = () => ({
			...h.fixState,
			[REPO]: {
				[String(PR_NUM)]: {
					budget_runs: AI_FIX_BUDGET_CEILING,
					budget_sha: "b".repeat(40),
				},
			},
		})
		await runTick(h.deps)

		expect(h.agentPosts).toHaveLength(2)
	})

	test("a genuinely permanent [INFRA] fault still pins", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: false, snippet: "[INFRA] Claude Code binary not found" }],
		})
		const first = await runTick(h.deps)
		expect(first).toContain("   🔔 Skip notified: Claude Code binary not found")
		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBe(
			"Claude Code binary not found",
		)
		// A missing binary is a property of the INSTALL: waiting changes nothing.
		expect((h.fixState[REPO][String(PR_NUM)] as any).budget_runs).toBeUndefined()
	})

	test("a NEW head sha releases the skip and the agent runs again", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: false, snippet: "[INFRA] gateway down" }],
		})
		await runTick(h.deps)
		expect(h.agentPosts).toHaveLength(1)

		// Same PR, new head — the state gate is keyed on the sha, so it opens.
		h.deps.loadFixState = () => ({
			...h.fixState,
			[REPO]: { [String(PR_NUM)]: { sha: "b".repeat(40), skip_reason: "gateway down" } },
		})
		await runTick(h.deps)

		expect(h.agentPosts).toHaveLength(2)
	})
})

describe("case 4b — a TRANSIENT [INFRA] failure is retried, never pinned", () => {
	// The live incident: a 403 FreeTierError from the gateway exited the CLI 1,
	// `claude-agent.ts` wrapped it as [INFRA] verbatim, and `isInfra`'s bare
	// prefix check wrote it into `skip_reason` — which pipeline.ts enforces
	// "until head SHA changes". Nothing would ever move that SHA, because the
	// cause was quota, not code. hub#46 and pr-agent-server#5 sat pinned like
	// that with a healthy agent behind them.
	const FREE_TIER_403 =
		'[INFRA] Claude Code exited 1: Failed to authenticate. API Error: 403 [403]: {"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}'

	test("the agent runs again on the next tick and no skip is recorded", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: false, snippet: FREE_TIER_403 }],
		})

		const first = await runTick(h.deps)
		expect(h.agentPosts).toHaveLength(1)
		expect(first).toContain(`   ⏭️  AI fix skipped: ${FREE_TIER_403}`)
		// The recorded state is the diagnostic attempt count — NOT a skip_reason.
		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBeUndefined()
		expect((h.fixState[REPO][String(PR_NUM)] as any).attempts).toBe(1)

		// The whole point: the very next tick asks the agent again instead of
		// honouring a skip that no code change could ever release.
		const second = await runTick(h.deps)
		expect(h.agentPosts).toHaveLength(2)
		expect(second).toContain("   🔁 Transient infra failure — will retry next tick (attempt 2)")
		expect(second).not.toContain("Permanently skipped")
		// Nothing is notified as a permanent skip, so the human is not told the PR
		// is finished with.
		expect(skipNotices(h)).toHaveLength(0)
		// Still no skip_reason after the second failure — retrying is not the same
		// as giving up, and the tally keeps rising for a human to see.
		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBeUndefined()
		expect((h.fixState[REPO][String(PR_NUM)] as any).attempts).toBe(2)
	})

	test("a PERMANENT [INFRA] failure on the same tick still pins, unchanged", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: false, snippet: "[INFRA] Claude Code binary not found" }],
		})

		await runTick(h.deps)
		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBe(
			"Claude Code binary not found",
		)
	})
})

describe("case 5 — a dependabot pin violation is closed before anything else", () => {
	const PINNED_REPO = "asepharyana/nextjs-template"
	const bumpPr = (over: Record<string, any> = {}) =>
		makePr({
			title: "chore(deps): bump typescript from 5.9.2 to 7.0.2",
			user: { login: "dependabot[bot]" },
			...over,
		})

	test("PATCH state=closed, and no review / agent / merge", async () => {
		const h = harness()

		const out = await processPr(h.deps, { token: "install-token", repo: PINNED_REPO, pr: bumpPr() })

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(closes(h.calls)).toHaveLength(1)
		expect(closes(h.calls)[0].json).toEqual({ state: "closed" })
		expect(approves(h.calls)).toBe(0)
		expect(merges(h.calls)).toBe(0)
		expect(h.agentPosts).toEqual([])
		expect(h.execCalls).toEqual([])
		expect(h.lines).toContain(
			"   ⛔ Toolchain pin violation: typescript 5.9.2 → 7.0.2 (allowed major 6)",
		)
		expect(h.lines).toContain(`   ✅ Closed #${PR_NUM} (pin violation)`)
	})

	test("a close that fails is reported and the PR is still abandoned", async () => {
		const h = harness()
		h.deps.api.request = async (method: string, path: string, o: { json?: unknown } = {}) => {
			h.calls.push({ method, path, json: o.json })
			if (method === "PATCH") return { status: 500, data: {} }
			return { status: 200, data: { repositories: [{ full_name: REPO }] } }
		}

		const out = await processPr(h.deps, { token: "install-token", repo: PINNED_REPO, pr: bumpPr() })

		// Python increments skipped ONLY on a 200 close (lines 1896-1897).
		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: false })
		expect(h.lines).toContain("   ⚠️  Close failed HTTP 500 — leaving open")
	})
})

describe("case 6 — red CI closes a stale dependabot PR and skips everyone else", () => {
	const RED_CHECKS = [{ name: "typecheck", status: "completed", conclusion: "failure" }]
	// TWO fixtures are needed to reach the CI gate, and both are the Python's
	// own gates rather than test conveniences:
	//   - `SAFE_REVIEW`, because line 2044 is only reachable through the review
	//     branch; a PR with no review `continue`s at 1934 with `triggered` set.
	//   - a seeded `already`, because STEP B runs on ALL PRs (line 1951) and the
	//     agent stub's verdict is a successful push, which increments
	//     `fixed_count` (line 2009) independently of the CI gate. Seeding
	//     `already` keeps this case about the CI decision alone.
	// `fix_commits: 2` = the agent's fix LANDED, so `shouldRetryAiFix` leaves it
	// alone and the stale-close path is exercised on its own. Without it this
	// fixture would (correctly) now re-offer the agent first, and the test would
	// be measuring two gates at once.
	const SEEDED = { [REPO]: { [String(PR_NUM)]: { sha: HEAD, fix_commits: 2 } } }
	// The age is computed against `deps.now()`, which the harness pins, so the
	// fixture's `created_at` has to be derived from the SAME clock — a real
	// `Date.now()` here would make the age negative and the close unreachable.
	const NOW_SEC = 1_700_000_000
	const daysAgo = (d: number) => iso((NOW_SEC - d * 86_400) * 1000)
	const STALE = { ...LOCKFILE_BUMP, created_at: daysAgo(3) }

	test("dependabot older than STALE_CI_CLOSE_DAYS is NOT closed", async () => {
		// This test used to assert the OPPOSITE — that a stale dependabot bump is
		// closed — and that assertion was correct for the old policy. MythEclipse
		// inverted it on 2026-10-16: closing a dependency bump is a SILENT LOSS.
		// The update disappears with no trace and nothing notices until a later
		// `pnpm audit` or the next Dependabot run trips over the gap. So a stale
		// bump stays open and keeps getting the agent.
		//
		// The case name above the block is now wrong too and is fixed with it.
		const h = harness({
			prs: [makePr(STALE)],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: RED_CHECKS,
			fixState: SEEDED,
			nowSec: NOW_SEC,
		})

		const out = await processPr(h.deps, { token: "install-token", repo: REPO, pr: makePr(STALE) })

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(closes(h.calls)).toHaveLength(0)
		expect(h.lines).toContain("   ⏭️  Already fixed at this SHA — skip AI fix")
		expect(h.lines).toContain("   🧪 CI: CI FAILED: typecheck")
		expect(h.lines).toContain(
			"   ⏳ CI failing 3.0d on a dependency bump — NOT closing it, the agent will keep fixing it",
		)
		expect(merges(h.calls)).toBe(0)
		expect(h.agentPosts).toEqual([])
	})

	test("a HUMAN PR older than STALE_CI_CLOSE_DAYS is closed", async () => {
		// The other half of the inversion, and the case that had no terminal path
		// at all: a human PR's red CI was only ever counted, so it printed
		// "Waiting for green CI" on every tick forever with nothing to grep for.
		const human = makePr({ ...STALE, user: { login: "somehuman" } })
		const h = harness({
			prs: [human],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: RED_CHECKS,
			fixState: SEEDED,
			nowSec: NOW_SEC,
		})

		const out = await processPr(h.deps, { token: "install-token", repo: REPO, pr: human })

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(closes(h.calls)).toHaveLength(1)
		expect(h.lines).toContain("   ⛔ CI failing for 3.0d — closing stale PR")
		expect(h.lines).toContain(`   ✅ Closed #${PR_NUM} (stale failing CI)`)
		expect(merges(h.calls)).toBe(0)
		expect(h.agentPosts).toEqual([])
	})

	test("a fresh dependabot PR is only waited on, not closed", async () => {
		const h = harness({
			prs: [makePr(LOCKFILE_BUMP)],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: RED_CHECKS,
			fixState: SEEDED,
		})
		const out = await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: makePr(LOCKFILE_BUMP),
		})

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(closes(h.calls)).toHaveLength(0)
		expect(h.lines).toContain("   ⏳ Waiting for green CI")
	})

	test("a non-dependabot red-CI PR is skipped, never closed", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: RED_CHECKS,
			fixState: SEEDED,
		})

		const out = await processPr(h.deps, ctx)

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(closes(h.calls)).toHaveLength(0)
		expect(h.lines).toContain("   ⏳ Waiting for green CI")
		// No age-based close for a human author: the Python's stale-CI close is
		// guarded by `author == "dependabot[bot]"` (line 2048) and nothing else.
		expect(h.lines).not.toContain(`   ⛔ CI failing for`)
	})
})

describe("case 7 — mergeable:false resolves once, then skips permanently", () => {
	test("one agent attempt, then the Python's exact unresolvable reason", async () => {
		// `NO_CODE_MARKER` puts this PR on the no_code_review path, so the AI fix is
		// skipped and the ONE agent call below is the conflict resolve itself.
		const h = harness({
			prs: [makePr({ ...LOCKFILE_BUMP, mergeable: false })],
			comments: [NO_CODE_MARKER],
			agent: [{ ok: false, snippet: "conflict with main, gave up" }],
		})

		const out = await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: makePr({ ...LOCKFILE_BUMP, mergeable: false }),
		})

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(h.agentPosts).toHaveLength(1)
		expect(merges(h.calls)).toBe(0)
		expect(closes(h.calls)).toHaveLength(0)

		expect(h.lines).toContain(
			"   📝 PR-Agent assessed (no-code/lockfile PR) — no code to review, treating as reviewed",
		)
		expect(h.lines).toContain("   🔴 Merge conflicts")
		expect(h.lines).toContain("   🤖 Resolving merge conflict with Claude Code...")
		expect(h.lines).toContain("   ⏭️  Conflict fix failed: conflict with main, gave up")
		expect(h.lines).toContain(`   🔔 Skip notified: ${UNRESOLVABLE_CONFLICT}`)
		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBe(UNRESOLVABLE_CONFLICT)
		expect(skipNotices(h)).toHaveLength(1)
		expect(h.notifies[0].status).toBe("skipped")
	})

	test("the reason is the Python's literal, not a paraphrase", () => {
		expect(UNRESOLVABLE_CONFLICT).toBe("Unresolvable merge conflict (Claude Code made no push)")
	})

	test("an [INFRA] failure records the stripped INFRA reason instead", async () => {
		const h = harness({
			prs: [makePr({ mergeable: false })],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [
				{ ok: false, snippet: "[INFRA] Claude Code not available at http://127.0.0.1:8642/v1" },
			],
		})

		await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: makePr({ mergeable: false }),
		})

		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBe(
			"Claude Code not available at http://127.0.0.1:8642/v1",
		)
	})

	test("a resolved conflict records the PUSHED tip, not the conflicted head", async () => {
		// The same rule as `stepAiFix`, at the resolver's two call sites. A
		// conflict resolution ALSO pushes, so recording the head the agent
		// started from leaves the state file one head behind the branch and the
		// next tick finds "Merge conflicts" again — resolving the same conflict
		// with a fresh 1800s agent run, indefinitely.
		//
		// `NO_CODE_MARKER` + the trivial title is what makes this measure the
		// RESOLVER and nothing else: `stepReview` sets `noCodeReview`, which
		// returns `stepAiFix` at its first line, so `c.headSha` is still the
		// conflicted head when the resolver runs and the two candidate values
		// differ. With the ordinary review fixture the AI fix runs first,
		// advances `c.headSha` to the pushed tip itself, and BOTH readings
		// agree — the assertion then passes whatever the resolver records.
		const PUSHED = "c".repeat(40)
		const conflicted = makePr({ ...LOCKFILE_BUMP, mergeable: false })
		const h = harness({
			prs: [conflicted],
			comments: [NO_CODE_MARKER],
			agent: [{ ok: true, snippet: "resolved" }],
			pushedSha: PUSHED,
			// [0] the resolver's pre-flight validity read, [1] its post-push re-fetch.
			pullReplySeq: [
				{ status: 200, data: conflicted },
				{ status: 200, data: makePr({ mergeable: true, head: { sha: PUSHED, ref: "f" } }) },
			],
		})

		await processPr(h.deps, { token: "install-token", repo: REPO, pr: conflicted })

		expect(h.agentPosts).toHaveLength(1) // the resolver's run, not the AI fix's
		expect(HEAD).not.toBe(PUSHED)
		expect(h.fixState[REPO][String(PR_NUM)].sha).toBe(PUSHED)
	})

	test("a successful resolve counts a fix and does NOT merge this tick", async () => {
		const h = harness({
			prs: [makePr({ mergeable: false })],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: true, snippet: "resolved" }],
		})

		const out = await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: makePr({ mergeable: false }),
		})

		expect(out).toEqual({ merged: false, triggered: false, fixed: true, skipped: true })
		expect(h.lines).toContain("   ✨ Conflict resolved: Claude Code pushed 1 improvement commit(s)")
		expect(merges(h.calls)).toBe(0)
	})

	test("mergeable:null is NOT the conflict branch — Python tests `is False`", async () => {
		const h = harness({
			prs: [makePr({ mergeable: null })],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } },
		})

		const out = await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: makePr({ mergeable: null }),
		})

		expect(h.lines).not.toContain("   🔴 Merge conflicts")
		expect(out.merged).toBe(true)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Beyond the seven: the 409 arm, the tick framing, and the lock contract
// ═══════════════════════════════════════════════════════════════════════════

describe("the merge 409 arm re-runs the resolve exactly once too", () => {
	test("the 409 arm", async () => {
		const h = harness({
			prs: [makePr({ ...LOCKFILE_BUMP })],
			comments: [NO_CODE_MARKER],
			agent: [{ ok: false, snippet: "still conflicted" }],
			merge: { status: 409, data: { message: "Merge conflict" } },
		})

		const out = await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: makePr(LOCKFILE_BUMP),
		})

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(h.agentPosts).toHaveLength(1)
		expect(h.lines).toContain("   ⚠️  Merge conflict")
		expect(h.lines).toContain(`   🔔 Skip notified: ${UNRESOLVABLE_CONFLICT}`)
	})
})

describe("runTick frames the report and counts the four booleans", () => {
	test("header, per-PR lines, then the summary block", async () => {
		const h = harness({ prs: [makePr()], nowSec: 1_700_000_000 })
		let clock = 1_700_000_000
		h.deps.now = () => {
			clock += 1.5
			return clock
		}

		const lines = await runTick(h.deps)

		expect(lines[0]).toMatch(/^🔍 PR Queue Worker — /)
		expect(lines[1]).toBe("=".repeat(50))
		expect(lines[2]).toBe("📋 Found 1 open PR(s) to process")
		expect(lines[3]).toBe("   ✨ AI auto-fix: ENABLED (Claude Code)")
		expect(lines[4]).toBe(`\n${"─".repeat(40)}`)
		expect(lines[5]).toBe(`🔀 ${REPO} #${PR_NUM} — Refactor: harden the parser`)
		expect(lines[6]).toBe("   👤 alice | branch: feature/harden → main")
		expect(lines).toContain("📡 No review → triggering PR-Agent...".replace("📡", "   📡"))

		// The summary block is SEVEN lines: the opening rule, the header, the four
		// counters, and the closing rule. Slicing six would drop the closing rule
		// and read the header as the block's first line.
		const tail = lines.slice(-7)
		expect(tail[0]).toBe(`\n${"=".repeat(50)}`)
		expect(tail[1]).toMatch(/^📊 Summary \(\d+\.\d+s\)$/)
		expect(tail[2]).toBe("   ✨ AI fixes applied: 0")
		expect(tail[3]).toBe("   ✅ Merged: 0")
		expect(tail[4]).toBe("   📡 Reviews triggered: 1")
		expect(tail[5]).toBe("   ⏭️  Skipped: 0")
		// The block is closed by a second rule line.
		expect(tail[6]).toBe("=".repeat(50))
	})

	test("a lock miss is silent: no scan, no sync, no report", async () => {
		const h = harness({ prs: [makePr()] })
		;(h.deps as any).lock = { acquire: () => null }

		const lines = await runTick(h.deps)

		expect(lines).toEqual([])
		expect(h.calls).toEqual([])
	})

	test("an empty queue with no sync lines stays truly silent", async () => {
		const h = harness({ prs: [] })
		const lines = await runTick(h.deps)
		expect(lines).toEqual([])
	})
})

describe("the gate fails closed when GitHub cannot answer, and a 5xx merge retries", () => {
	test("a 500 on /check-runs stops the PR without approving or merging", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD, notified: false } } },
			checkRunsReply: { status: 500, data: {} },
		})

		const out = await processPr(h.deps, ctx)

		expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true })
		expect(approves(h.calls)).toBe(0)
		expect(merges(h.calls)).toBe(0)
		expect(h.lines).toContain("   🧪 CI: ⚠️ CI status unavailable (HTTP 500)")
		expect(h.lines).toContain(
			"   ⏳ CI unknown — not merging on an unverified gate; will retry next tick",
		)
		expect(h.notifies).toEqual([])
	})

	test("a merge answered with 500 notifies as a retry, not as a review failure", async () => {
		const h = harness({
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } },
			merge: { status: 500, data: {} },
		})

		const out = await processPr(h.deps, ctx)

		expect(out.merged).toBe(false)
		expect(h.lines).toContain("   ⚠️  Merge deferred: GitHub HTTP 500 — will retry next tick")
		expect(h.notifies.map((n) => n.status)).toEqual(["retry"])
		expect(h.notifies[0].summary).toContain("transient")
	})

	test("a real refusal still notifies as a failure", async () => {
		const h = harness({
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } },
			merge: {
				status: 403,
				data: { message: "refusing to allow a GitHub App to update a workflow" },
			},
		})

		const out = await processPr(h.deps, ctx)

		expect(out.merged).toBe(false)
		expect(h.notifies.map((n) => n.status)).toEqual(["failed"])
		expect(h.notifies[0].summary).toContain("Merge failed HTTP 403")
	})
})

describe("--dry walks the same gates and suppresses every effect", () => {
	/**
	 * The brief's `--dry` is "no state write, no push, no PR, no Discord", and
	 * the controller's ruling is that it must be a FLAG on the deps, never an
	 * `if (dry) return` in front of the pipeline — otherwise the dry path is the
	 * one nobody runs. So this asserts the pipeline DECIDES under dry: it reaches
	 * approve-and-merge and reports what it would have done.
	 *
	 * It is the real CLI's `--dry` path, driven through the same `runTick` the CLI
	 * calls, which is as close to an end-to-end rehearsal as a hermetic suite gets.
	 */
	test("a mergeable PR reports 'would approve and merge', saves nothing, notifies nobody", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } },
			dry: true,
		})
		let saved = 0
		h.deps.saveFixState = () => {
			saved += 1
		}
		let flushed = 0
		h.deps.flushReport = async () => {
			flushed += 1
		}
		h.deps.notify = () => Promise.resolve()
		h.deps.loadFixState = () => ({ [REPO]: { [String(PR_NUM)]: { sha: HEAD } } })

		const lines = await runTick(h.deps)

		// The decision is reached, not skipped.
		expect(lines).toContain("   👍 Approving...")
		expect(lines).toContain(`   🧪 dry run: would approve and merge #${PR_NUM}`)
		// And NONE of the four effects happened.
		expect(approves(h.calls)).toBe(0)
		expect(merges(h.calls)).toBe(0)
		expect(h.notifies).toEqual([])
		expect(saved).toBe(0)
		expect(flushed).toBe(0) // flush posts to Discord on a non-TTY
	})

	test("a pin violation under dry reports the close it would make, and makes none", async () => {
		const h = harness({ dry: true })

		await processPr(h.deps, {
			token: "install-token",
			repo: "asepharyana/nextjs-template",
			pr: makePr({
				title: "chore(deps): bump typescript from 5.9.2 to 7.0.2",
				user: { login: "dependabot[bot]" },
			}),
		})

		expect(h.lines).toContain(
			"   ⛔ Toolchain pin violation: typescript 5.9.2 → 7.0.2 (allowed major 6)",
		)
		expect(h.lines).toContain("   🧪 dry run: would close #7 (pin violation)")
		expect(closes(h.calls)).toEqual([])
	})
})

/**
 * The `stepLockPrefix` guard matrix (Python 1961-1973).
 *
 *   if has_bun:                    -> fix_bun_lock
 *   elif "uv.lock" not in ci_msg:  -> fix_uv_lock
 *   else                           -> change nothing
 *
 * The third arm is the one that was wrong once. Rewriting the `elif` as a
 * two-way disjunction (`has_bun || msg.includes("uv.lock")`) inverts the guard:
 * on a non-Bun repo whose failing check already names `uv.lock`, the port
 * re-resolves and PUSHES a `bun.lock` the repo does not use, on a PR the Python
 * left untouched. These four cases exist so that inversion cannot come back —
 * the last one fails if the negative guard is dropped again.
 */
describe("the lockfile pre-fix guard (Python 1961-1973)", () => {
	const typecheck = (names: string[]) => [
		{ name: "typecheck", status: "completed", conclusion: "failure" },
		...names.map((name) => ({ name, status: "completed", conclusion: "failure" })),
	]
	const run = async (opts: { hasBunLock: boolean; extraCheck: string }) => {
		const h = harness({
			prs: [makePr({ ...LOCKFILE_BUMP })],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: typecheck([opts.extraCheck]),
			hasBunLock: opts.hasBunLock,
			dry: true,
		})
		// `processPr` takes the OPEN PR, not the harness queue — the pre-fix only
		// runs for a trivial title (Python 1953: `is_trivial_pr(title, author)`),
		// so passing the default non-trivial fixture would silently skip the step
		// and make all four cases pass for the wrong reason.
		await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: makePr({ ...LOCKFILE_BUMP }),
		})
		return h
	}

	test("a Bun repo takes the bun arm regardless of what CI names", async () => {
		const h = await run({ hasBunLock: true, extraCheck: "uv.lock" })
		expect(h.lines).toContain("   🔧 CI failing: bun.lock stale — pre-fixing...")
	})

	test("a non-Bun repo whose CI does NOT name uv.lock takes the uv arm", async () => {
		const h = await run({ hasBunLock: false, extraCheck: "lint" })
		expect(h.lines).toContain("   🔧 CI failing: uv.lock stale — pre-fixing...")
	})

	test("a non-Bun repo whose CI ALREADY names uv.lock is left alone", async () => {
		// Python 1973's comment: re-resolving the file uv just complained about
		// costs a clone and changes nothing.
		const h = await run({ hasBunLock: false, extraCheck: "uv.lock" })
		expect(h.lines).not.toContain("   🔧 CI failing: bun.lock stale — pre-fixing...")
		expect(h.lines).not.toContain("   🔧 CI failing: uv.lock stale — pre-fixing...")
		// And the decisive one: neither toolchain was run.
		expect(h.execCalls).toEqual([])
	})

	test("a Bun repo that already names uv.lock still pre-fixes bun.lock", async () => {
		// The guard lives on the uv arm only, so a Bun repo is unaffected.
		const h = await run({ hasBunLock: true, extraCheck: "uv.lock" })
		expect(h.lines).toContain("   🔧 CI failing: bun.lock stale — pre-fixing...")
	})
})

describe("the lock is released on every exit", () => {
	test("a throwing tick still releases, so the next tick can claim", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prq-lock-"))
		const lockPath = join(dir, "worker.lock")
		let releaseCount = 0
		const deps = {
			...harness({ throwOn: (p) => p.includes("/pulls?") }).deps,
			lock: {
				// Claim THIS test's lock file, never the `LOCK_FILE` the tick passes in:
				// /tmp/pr-queue-worker.lock belongs to the live worker, so claiming it
				// races the 5-minute timer — and the two assertions below then check a
				// file nothing ever created.
				acquire: () => {
					const lock = WorkerLock.acquire(lockPath)
					if (!lock) return null
					return {
						release: () => {
							releaseCount += 1
							lock.release()
						},
					}
				},
			},
		}

		try {
			await expect(runTick(deps)).rejects.toThrow("boom")
			expect(releaseCount).toBe(1)
			expect(existsSync(lockPath)).toBe(false)
			// The property that matters in production: a second tick is not wedged.
			expect(WorkerLock.acquire(lockPath)).not.toBeNull()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// PREVENTION — the recurrence guards for the 2026-10-15 incident
// ═══════════════════════════════════════════════════════════════════════════

describe("prevention — a conflicted PR is NEVER approved", () => {
	// THE RECURRENCE VECTOR. On 2026-10-15 both stuck PRs printed
	//   👍 Approving... / ✅ Approved! / 🔀 Merging... / ⚠️ Branch protection
	// The approval is a PUBLIC, ATTRIBUTED review that survives the failed
	// merge, so every occurrence leaves a permanent artifact endorsing a PR
	// that cannot be merged — and no amount of fixing the 405 message undoes
	// it. Mergeability is therefore re-read immediately before approving, and
	// a conflicted PR is refused BEFORE any review is published.
	//
	// This matters more than it looks: `mergeable` is read ONCE at scan time,
	// and GitHub returns `null` while it computes. Treating "not computed yet"
	// as "no conflicts" is the same mistake as treating a transient 403 as
	// permanent — inferring a positive from a value that means UNKNOWN.
	test("a fresh mergeable:false stops the tick before any approval is published", async () => {
		const h = harness({
			prs: [makePr()], // scan-time read says mergeable:true
			comments: [reviewComment(SAFE_REVIEW)],
			// …but the live read just before merging says otherwise.
			pullReply: {
				status: 200,
				data: makePr({ mergeable: false, mergeable_state: "dirty" }),
			},
		})

		const out = await processPr(h.deps, ctx)

		expect(approves(h.calls)).toBe(0)
		expect(merges(h.calls)).toBe(0)
		expect(h.lines.some((l) => l.includes("Approved!"))).toBe(false)
		// The gate routes it to the CONFLICT RESOLVER, whose line is distinct
		// from the 405 arm's post-hoc diagnosis.
		expect(h.lines.some((l) => l.includes("Merge conflicts"))).toBe(true)
		expect(h.lines.some((l) => l.includes("resolving before approving"))).toBe(true)
		expect(out.merged).toBe(false)
	})

	test("mergeable:null (GitHub still computing) is NOT treated as no-conflict", async () => {
		// `null` means "unknown", and the old code merged straight through it.
		// The PR must be left for a later tick rather than approved on a guess.
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			pullReply: { status: 200, data: makePr({ mergeable: null }) },
		})

		await processPr(h.deps, ctx)

		expect(approves(h.calls)).toBe(0)
		expect(merges(h.calls)).toBe(0)
		expect(h.lines.some((l) => l.includes("still computing"))).toBe(true)
	})

	test("a genuinely mergeable PR is still approved and merged (no regression)", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			pullReply: {
				status: 200,
				data: makePr({ mergeable: true, mergeable_state: "clean" }),
			},
		})

		const out = await processPr(h.deps, ctx)

		expect(approves(h.calls)).toBe(1)
		expect(merges(h.calls)).toBe(1)
		expect(out.merged).toBe(true)
		expect(h.lines).toContain("   ✅ MERGED! SHA: c0ffee")
	})
})

describe("prevention — the ops report must never assert an unchecked cause", () => {
	// The other half. A wrong message is not cosmetic: "Branch protection
	// blocks merge" sent a human to configure rules on repos that had none.
	// Every cause the report prints is now one that was READ, never inferred
	// from a status code that admits more than one explanation.
	test("no report line names a cause the worker did not verify", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			merge: { status: 405, data: {} },
			pullReply: { status: 200, data: makePr({ mergeable_state: "dirty" }) },
		})
		await processPr(h.deps, ctx)

		const lines = h.lines.join("\n")
		expect(lines).toContain("mergeable_state: dirty")
		expect(lines).not.toContain("Branch protection")
	})
})

describe("prevention — a no-commit 'fix' does not lock out the agent", () => {
	// mcpedia#28, verbatim from the ops report:
	//
	//   ⏭️  Already fixed at this SHA — skip AI fix
	//   ✅ Security: clean
	//   🧪 CI: CI FAILED: moon check
	//   🔁 CI still red: CI FAILED: moon check (attempt 97 at this SHA)
	//
	// A vitest 5.0.3→5.0.4 dev-dep bump. `runAiFix` reported a clean tree, which
	// is HONEST — there is nothing in a lockfile bump for an agent to improve —
	// but `markFixed` then claimed the head, and `alreadyFixed` read that as "do
	// not ask again". The one thing that could have fixed CI was therefore never
	// offered, for 97 ticks.
	//
	// The recorded "fixed" was about the DIFF; the blocker was the CI's own
	// configuration. `shouldRetryAiFix` re-offers on exactly that gap.
	const DEPENDABOT = makePr({ user: { login: "dependabot[bot]" } })
	const noCommitFixState = (fixCommits?: number): FixState => ({
		[REPO]: { [String(PR_NUM)]: { sha: HEAD, fix_commits: fixCommits } },
	})

	test("a dependabot bump fixed with NO commit is offered the agent again", async () => {
		const h = harness({
			prs: [DEPENDABOT],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: noCommitFixState(0),
			checkRunsReply: { status: 500, data: {} }, // red CI
		})

		await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: DEPENDABOT,
		})

		expect(h.lines.some((l) => l.includes("produced no commit"))).toBe(true)
		// The whole point: the agent is actually asked, not merely announced.
		expect(h.lines.some((l) => l.includes("Running Claude Code AI fix"))).toBe(true)
	})

	test("a fix that DID commit is not re-offered — that needs a human", async () => {
		const h = harness({
			prs: [DEPENDABOT],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: noCommitFixState(2),
			checkRunsReply: { status: 500, data: {} },
		})

		await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: DEPENDABOT,
		})

		expect(h.lines.some((l) => l.includes("produced no commit"))).toBe(false)
		expect(h.lines).toContain("   ⏭️  Already fixed at this SHA — skip AI fix")
	})

	test("a HUMAN PR with a no-commit fix is not re-offered (author may be pushing)", async () => {
		const h = harness({
			prs: [makePr()], // alice
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: noCommitFixState(0),
			checkRunsReply: { status: 500, data: {} },
		})

		await processPr(h.deps, ctx)

		expect(h.lines.some((l) => l.includes("produced no commit"))).toBe(false)
	})

	test("the re-offer is bounded — it cannot become a 30-minute loop", async () => {
		// One agent run is up to 1800s. Three re-offers is the ceiling, and past
		// it the PR falls back to the ordinary red-CI wait (NOT a skip: a pin here
		// would be a permanent stall, the exact bug fixed on 2026-10-15).
		const h = harness({
			prs: [DEPENDABOT],
			comments: [reviewComment(SAFE_REVIEW)],
			fixState: {
				[REPO]: {
					[String(PR_NUM)]: {
						sha: HEAD,
						fix_commits: 0,
						attempt_sha: HEAD,
						attempts: AI_FIX_RETRY_CEILING,
					},
				},
			},
			checkRunsReply: { status: 500, data: {} },
		})

		await processPr(h.deps, {
			token: "install-token",
			repo: REPO,
			pr: DEPENDABOT,
		})

		expect(h.lines.some((l) => l.includes("already re-offered"))).toBe(true)
		expect(h.lines.some((l) => l.includes("Running Claude Code AI fix"))).toBe(false)
		// Bounded, not abandoned.
		expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBeUndefined()
	})
})

describe("prevention — a landed fix must not re-invite the agent forever", () => {
	// hub#53, verbatim from the ops report:
	//
	//   ✨ Claude Code pushed 2 improvement commit(s)
	//   🔄 Head SHA updated for merge
	//   ⏳ Mergeability still computing — not approving on an unknown, retrying next tick
	//   🔁 mergeability unknown (GitHub still computing) (attempt 1 at this SHA — retrying next tick)
	//
	// THREE consecutive `fix: auto-fix code quality` commits landed on that one
	// branch (09:37, 09:45, 09:54 WIB), and the state file ended up recording
	// `sha` = the SECOND of them while `attempt_sha` named the third.
	//
	// THE RECORD WAS WRITTEN FROM THE PRE-PUSH HEAD. `stepAiFix` calls
	// `markFixed(..., c.headSha)` and only THEN `refetchHead`, so the fix's own
	// push invalidated the record in the same breath it was written: the sha
	// recorded was the head the agent STARTED from, not the head it LEFT.
	//
	// The next tick scans the real head, `alreadyFixed` compares it against that
	// stale sha, returns false because they differ, and buys another run of up to
	// `AI_FIX_TIMEOUT` (1800s) — whose push moves the head again, and so on. The
	// loop is self-sustaining and costs 30 minutes per turn, which is why the
	// tick that produced this report took 453.7s and `🔄 Head SHA updated for
	// merge` is its fingerprint: that line only prints when the head moved out
	// from under a record that was already stale.
	const PUSHED = "b".repeat(40)
	const movedReply = { status: 200, data: makePr({ head: { sha: PUSHED, ref: "feature/harden" } }) }

	test("the recorded head is the PUSHED tip, not the head the agent started from", async () => {
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: true, snippet: "Claude Code pushed 1 improvement commit(s)" }],
			pushedSha: PUSHED,
			// The pre-agent validity read sees the old head; the post-push
			// re-fetch sees the branch as the fix left it.
			pullReplySeq: [{ status: 200, data: makePr() }, movedReply],
		})

		await processPr(h.deps, ctx)

		// HEAD is the head BEFORE the fix; PUSHED is what the fix's push created.
		expect(HEAD).not.toBe(PUSHED)
		expect(h.fixState[REPO][String(PR_NUM)].sha).toBe(PUSHED)
	})

	test("the next tick does NOT re-invite the agent at the new head", async () => {
		// The loop, end to end: two consecutive ticks over the same branch. With
		// the stale record the second tick sees a head the state file has never
		// heard of and runs the agent a SECOND time.
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: true, snippet: "Claude Code pushed 1 improvement commit(s)" }],
			pushedSha: PUSHED,
			pullReplySeq: [{ status: 200, data: makePr() }, movedReply],
		})

		await processPr(h.deps, ctx)
		expect(h.agentPosts).toHaveLength(1)

		// Tick 2: the branch as the fix left it.
		const moved = makePr({ head: { sha: PUSHED, ref: "feature/harden" } })
		await processPr(h.deps, { token: "install-token", repo: REPO, pr: moved })

		expect(h.agentPosts).toHaveLength(1)
		expect(h.lines).toContain("   ⏭️  Already fixed at this SHA — skip AI fix")
	})

	test("a fix that pushed nothing still records the head it was given", async () => {
		// The other half of the rule: with no push there is no new head, so the
		// record must stay exactly what it was. `pushedSha` is unset here, which
		// is what a clean-tree run produces.
		const h = harness({
			prs: [makePr()],
			comments: [reviewComment(SAFE_REVIEW)],
			agent: [{ ok: true, snippet: "Claude Code found nothing to improve" }],
		})

		await processPr(h.deps, ctx)

		expect(h.fixState[REPO][String(PR_NUM)].sha).toBe(HEAD)
	})
})

describe("prevention — a HUMAN PR on red CI is visible, not silent", () => {
	// The last unbounded loop. `noteFailure` on the red-CI arm is gated on
	// `author === "dependabot[bot]"`, and the stale-close escape hatch is gated the
	// same way. So a HUMAN PR whose CI never goes green prints
	// `⏳ Waiting for green CI` on every tick, forever, leaving no state at all —
	// the exact "no rules" gap the `attempts` field's doc comment describes for
	// GMW#109. Dependabot is safe (tally + 2-day close); nobody is looking at the
	// human case.
	test("a human PR on red CI records the attempt", async () => {
		const h = harness({
			prs: [makePr()], // alice, NOT dependabot
			comments: [reviewComment(SAFE_REVIEW)],
			// Defined inline: this describe is outside case 6's scope, where the
			// shared RED_CHECKS constant lives.
			checkRuns: [{ name: "typecheck", status: "completed", conclusion: "failure" }],
		})

		await processPr(h.deps, ctx)

		expect(h.lines.some((l) => l.includes("Waiting for green CI"))).toBe(true)
		// The tally is the ONLY thing that makes a human-visible stall visible.
		expect(h.fixState[REPO][String(PR_NUM)].attempts).toBe(1)
		// Still never a pin — the author may be mid-push, and a pin here would be
		// the permanent stall fixed on 2026-10-15.
		expect(h.fixState[REPO][String(PR_NUM)].skip_reason).toBeUndefined()
	})
})

describe("disposition — humans get closed, dependabot gets fixed", () => {
	// MythEclipse's policy, 2026-10-16: a HUMAN PR that is broken, low-quality or
	// harmful is disposable — close it. A DEPENDABOT bump must NOT be closed,
	// because closing one is a silent loss: the update disappears and nobody
	// notices for two weeks, until a later `pnpm audit` or the next Dependabot run
	// trips over it. Those get AUTOFIXED instead, even at the cost of a long agent
	// run — a breaking change is still worth attempting, and a human is available
	// to reject the result.
	//
	// This INVERTS two things the worker had backwards:
	//   1. `closeStaleCiPr` fired only for dependabot (the one author that must
	//      never be auto-closed), and never for humans (the one that should).
	//   2. safety-blocked and merge-refused arms were counted forever for humans
	//      with no exit.
	//
	// So: humans get a TERMINAL disposition, dependabot gets an UNBOUNDED retry
	// with the agent. Both are bounded — by a different mechanism each. The
	// threshold itself (`STALE_CI_CLOSE_DAYS`, 2) is the guard that keeps a PR
	// mid-review from vanishing; see the two tests below it.
	test("a HUMAN PR on long-red CI is CLOSED, not waited on", async () => {
		const NOW_SEC = 1_700_000_000
		const human = makePr({ created_at: iso((NOW_SEC - 3 * 86_400) * 1000) })
		const h = harness({
			prs: [human],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: [{ name: "typecheck", status: "completed", conclusion: "failure" }],
			nowSec: NOW_SEC,
		})

		const out = await processPr(h.deps, { token: "install-token", repo: REPO, pr: human })

		expect(closes(h.calls)).toHaveLength(1)
		expect(closes(h.calls)[0].json).toEqual({ state: "closed" })
		expect(h.lines).toContain(`   ✅ Closed #${PR_NUM} (stale failing CI)`)
		expect(out.merged).toBe(false)
	})

	test("a DEPENDABOT bump on long-red CI is NEVER closed", async () => {
		// The regression this whole block exists to prevent: dependabot used to be
		// the ONLY author `closeStaleCiPr` applied to, so an incompatible bump was
		// closed and silently lost.
		const NOW_SEC = 1_700_000_000
		const bot = makePr({
			user: { login: "dependabot[bot]" },
			created_at: iso((NOW_SEC - 30 * 86_400) * 1000),
		})
		const h = harness({
			prs: [bot],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: [{ name: "typecheck", status: "completed", conclusion: "failure" }],
			nowSec: NOW_SEC,
		})

		await processPr(h.deps, { token: "install-token", repo: REPO, pr: bot })

		expect(closes(h.calls)).toHaveLength(0)
		expect(h.lines.some((l) => l.includes("stale failing CI"))).toBe(false)
		expect(h.lines.some((l) => l.includes("Waiting for green CI"))).toBe(true)
		// Counted, so the stall is visible rather than silent.
		expect(h.fixState[REPO][String(PR_NUM)].attempts).toBe(1)
		// And never a pin — a pin would block the bump forever, which is worse
		// than the loop this replaced.
		expect(h.fixState[REPO][String(PR_NUM)].skip_reason).toBeUndefined()
	})

	test("a HUMAN PR too young to close is still waited on", async () => {
		// The age guard is the whole safety of auto-closing someone's work: a PR
		// mid-review must not disappear because CI is briefly red.
		const NOW_SEC = 1_700_000_000
		const fresh = makePr({ created_at: iso((NOW_SEC - 3600) * 1000) })
		const h = harness({
			prs: [fresh],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: [{ name: "typecheck", status: "completed", conclusion: "failure" }],
			nowSec: NOW_SEC,
		})

		await processPr(h.deps, { token: "install-token", repo: REPO, pr: fresh })

		expect(closes(h.calls)).toHaveLength(0)
		expect(h.lines.some((l) => l.includes("Waiting for green CI"))).toBe(true)
	})

	test("dry run reports the close without making it", async () => {
		const NOW_SEC = 1_700_000_000
		const human = makePr({ created_at: iso((NOW_SEC - 5 * 86_400) * 1000) })
		const h = harness({
			prs: [human],
			comments: [reviewComment(SAFE_REVIEW)],
			checkRuns: [{ name: "typecheck", status: "completed", conclusion: "failure" }],
			nowSec: NOW_SEC,
			dry: true,
		})

		await processPr(h.deps, { token: "install-token", repo: REPO, pr: human })

		expect(closes(h.calls)).toHaveLength(0)
		expect(h.lines.some((l) => l.includes("dry run: would close"))).toBe(true)
	})
})

describe("clone workdirs are swept for closed PRs", () => {
	// The missing sibling of `pruneClosedFixState`. `/tmp/pr-queue-work` was
	// cleaned only on an error path — the clone is REUSED across ticks on purpose
	// — so one directory per PR ever touched accumulated. On 2026-10-17 they
	// reached 56 dirs / 1.8G on a 7.8G tmpfs and filled it, which failed an
	// UNRELATED service's deploy with `No space left on device`, because the tar
	// staged its payload in /tmp. A leak in one service must not be able to do
	// that again.
	const tmp = () => mkdtempSync(join(tmpdir(), "sweep-"))
	// Backdated past the real `SWEEP_MIN_AGE_HOURS` floor by default, so every
	// case below exercises the shipped threshold rather than a bypass. A case
	// that wants a FRESH directory says so explicitly (see the "FRESH workdir"
	// test, which is the one that must stay fresh).
	const mk = (dir: string, names: string[], ageHours = SWEEP_MIN_AGE_HOURS + 1) => {
		mkdirSync(dir, { recursive: true })
		const old = new Date(Date.now() - ageHours * 3_600_000)
		for (const n of names) {
			mkdirSync(join(dir, n), { recursive: true })
			utimesSync(join(dir, n), old, old)
		}
	}

	test("removes workdirs for closed PRs and keeps open ones", () => {
		// Exercises the REAL function, not a copy of its logic. An earlier version
		// of this test re-implemented the mapping inline and passed while the
		// shipped code was wrong.
		const dir = tmp()
		try {
			mk(dir, ["asepharyana_hub_52", "asepharyana_GMW_109", "asepharyana_mcpedia_28"])
			const removed = sweepStaleWorkdirs(dir, new Set(["asepharyana/hub/52"]))
			expect(removed).toBe(2)
			expect(readdirSync(dir)).toEqual(["asepharyana_hub_52"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("a live PR's lockfix/bunfix workdir is NOT swept", () => {
		// The bug this test exists for. `relock.ts` builds
		// `${repo}_lockfix_${pr}`, so the naive key is `owner/name_lockfix/pr` —
		// which never matches the open set (`owner/name/pr`) and would have swept
		// a live PR's relock tree out from under `bun install`.
		const dir = tmp()
		try {
			mk(dir, [
				// The REAL forms, from `relock.ts` (`${repo}_lockfix_${pr}`) — the PR
				// number is the TRAILING token. A fixture like
				// `asepharyana_hub_47_lockfix` is a name the code never produces,
				// and writing it here is what made the first version of this test
				// assert the wrong thing.
				"asepharyana_hub_lockfix_47",
				"asepharyana_hub_bunfix_47",
				"asepharyana_hub_47",
				"asepharyana_hub_lockfix_48", // closed — must go
			])
			const removed = sweepStaleWorkdirs(dir, new Set(["asepharyana/hub/47"]))
			expect(removed).toBe(1)
			expect(readdirSync(dir).sort()).toEqual([
				"asepharyana_hub_47",
				"asepharyana_hub_bunfix_47",
				"asepharyana_hub_lockfix_47",
			])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("a non-numeric name is never swept", () => {
		// Refusing to guess is the safety property: an unrecognised name costs one
		// stale directory, a wrong `rm -rf` costs a running clone mid-agent-run.
		const dir = tmp()
		try {
			mk(dir, ["claude_pr_6.prompt.txt", "some-random-dir", "notes"])
			const removed = sweepStaleWorkdirs(dir, new Set(["asepharyana/hub/52"]))
			expect(removed).toBe(0)
			expect(readdirSync(dir)).toHaveLength(3)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("an empty scan sweeps OLD workdirs (the case that filled /tmp)", () => {
		// This test previously asserted the OPPOSITE — that an empty open set
		// sweeps nothing — and it was wrong. Zero open PRs is exactly when the
		// garbage accumulates: with no PRs anywhere, every workdir is stale by
		// definition. Measured on 2026-10-17: 0 open PRs, 56 stale workdirs, sweep
		// skipped, /tmp kept filling until it broke another service's deploy.
		//
		// The age floor is what makes this safe without a special case. A failed
		// or partial scan cannot delete a directory a tick is using, because such
		// a directory was touched minutes ago; only OLD ones go.
		const dir = tmp()
		try {
			mk(dir, ["asepharyana_hub_52", "asepharyana_GMW_109"]) // backdated = old
			expect(sweepStaleWorkdirs(dir, new Set())).toBe(2)
			expect(readdirSync(dir)).toHaveLength(0)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("a FRESH workdir is not swept even when its PR is absent from the scan", () => {
		// THE LOAD-BEARING GUARD. `gatherOpenPrs` can return a PARTIAL list — a
		// rate-limited or failed per-repo call yields fewer PRs, not an error. So
		// "PR not in the open set" alone would delete a workdir a tick is using
		// RIGHT NOW. The age floor is what closes that, because the two conditions
		// must AGREE: a directory in active use was touched minutes ago.
		const dir = tmp()
		try {
			// ageHours = 0: mtime is NOW, which is the whole point of this case.
			mk(dir, ["asepharyana_hub_47"], 0)
			// PR absent from the scan: exactly the dangerous case.
			const removed = sweepStaleWorkdirs(dir, new Set(["asepharyana/other/1"]))
			expect(removed).toBe(0)
			expect(readdirSync(dir)).toEqual(["asepharyana_hub_47"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("an OLD workdir whose PR is absent from the scan IS swept", () => {
		// The other half: the floor must not make the sweep inert. `mk` backdates
		// past the real floor, and this asserts removal — so the guard is proven
		// to be a threshold rather than an off switch.
		const dir = tmp()
		try {
			mk(dir, ["asepharyana_hub_47"])
			const removed = sweepStaleWorkdirs(dir, new Set(["asepharyana/other/1"]))
			expect(removed).toBe(1)
			expect(readdirSync(dir)).toHaveLength(0)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("prompt audits in the PARENT dir are reclaimed by age", () => {
		// The second leak, and it is invisible to a sweep that only walks the
		// clone directory: `claude-agent.ts` writes `<label>.prompt.txt` beside the
		// workdir, so it lands in TMP_BASE itself. 35 had accumulated when this was
		// found — one per agent run, none ever removed, because sweeping the
		// directory removes the clone and leaves the file standing next to it.
		const dir = mkdtempSync(join(tmpdir(), "audit-"))
		try {
			const now = Date.now()
			const write = (name: string, ageDays: number) => {
				writeFileSync(join(dir, name), "prompt")
				const t = new Date(now - ageDays * 86_400_000)
				utimesSync(join(dir, name), t, t)
			}
			write("claude_pr_109.prompt.txt", 30) // old — reclaimed
			write("claude_pr_114.prompt.txt", 8) // past 7d — reclaimed
			write("claude_pr_29.prompt.txt", 0) // fresh — kept
			// Not ours: the state files, the lock, unrelated leftovers. A sweep that
			// matched loosely here would delete the worker's own queue memory.
			write("pr-queue-fix-state.json", 30)
			write("ks-backup.yaml", 30)

			const removed = sweepPromptAudits(dir)
			expect(removed).toBe(2)
			expect(readdirSync(dir).sort()).toEqual([
				"claude_pr_29.prompt.txt",
				"ks-backup.yaml",
				"pr-queue-fix-state.json",
			])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
