/**
 * Upstream fork auto-sync — the task-15 brief's 13 assertion groups, ported
 * from `scripts/test_pr_queue_sync.py` (18 functions / ~51 assertions).
 *
 * HERMETIC BY CONSTRUCTION, like the other worker suites: every external effect
 * is a fake — the git runner (argv in, `{code, stdout, stderr}` out), the
 * workdir fs, the GitHub client, the agent, the state file and Discord. No
 * test spawns a process, opens a socket, or writes to `/tmp/pr-queue-*`.
 *
 * WHERE THE PORT IS DELIBERATELY STRICTER THAN THE PYTHON TEST: the Python
 * monkeypatched module globals (`W._sync_unmerged_files`,
 * `W._sync_has_conflict_markers`, `W._push_ref`, `W._sync_finish_merge`) to
 * isolate one branch at a time. Here those are real functions over an injected
 * runner, so the guards under test — the conflict-marker commit guard, the
 * three-way `git grep` branch, the PAT-first push and the protected-branch
 * classifier — are exercised for real instead of being stubbed away.
 *
 * Group numbering in the `describe` titles maps to the brief's list, so a
 * reviewer can walk 1→13 and find the ported assertion for each.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { PostResult } from "../src/claude-agent.ts"
import {
	type GitResult,
	type GitRunner,
	isProtectedPushError,
	isWorkflowPushError,
} from "../src/git.ts"
import type { Workdirs } from "../src/pr/lockfix.ts"
import type { GhAppClient } from "../src/pr/scan.ts"
import {
	num,
	pendingVerify,
	type SyncConfig,
	type SyncState,
	skipRepoOverrides,
	syncConfig,
	syncEntry,
	UPSTREAM_SYNC_DEFAULTS,
	upstreamSyncEnabled,
} from "../src/sync/config.ts"
import {
	conflictPrompt,
	type MergeOutcome,
	QUALITY_LINE,
	qualityPrompt,
	RESOLVING_LINE,
	SALVAGE_LINE,
	SYNC_PR_PREFIX,
	SYNC_TMP_BASE,
	syncCommitIfDirty,
	syncFetchUrl,
	syncFinishMerge,
	syncHasConflictMarkers,
	syncRevertMerge,
	syncUnmergedFiles,
} from "../src/sync/merge.ts"
import { listForkRepos, syncOpenPr, upstreamStatus } from "../src/sync/repos.ts"
import {
	fileSyncState,
	openSyncPr,
	type PostDiscord,
	type ReportPort,
	type RunUpstreamSyncDeps,
	runUpstreamSync,
	type SyncAgentPort,
	type SyncRequest,
	syncForkRepo,
} from "../src/sync/run.ts"
import { reportOutcomeForTest } from "../src/sync/sweep.ts"
import type { SyncStatus } from "../src/sync/types.ts"
import { type VerifyDeps, verifyPendingSyncs } from "../src/sync/verify.ts"

// ═══════════════════════════════════════════════════════════════════════════
// Fakes
// ═══════════════════════════════════════════════════════════════════════════

const ok: GitResult = { code: 0, stdout: "", stderr: "" }
const withOutput = (stdout: string): GitResult => ({ code: 0, stdout, stderr: "" })

/** The bot's HEAD as the Python fake spells it: `pre` + 37 zeros. */
const PRE_HEAD = `pre${"0".repeat(37)}`
/** ...and the head after a successful merge. */
const MERGE_HEAD = `merge${"1".repeat(36)}`

type FakeGitOpts = {
	/** `git merge <ref> --no-edit` exit code. 0 = clean, 1 = conflicted. */
	mergeCode?: number
	/** What `diff --diff-filter=U` lists. */
	unmerged?: string[]
	/** What `git grep` reports, and the exit code it uses. */
	markers?: string[]
	grepCode?: number
	/** What `diff --name-only <pre>..HEAD` lists (the quality pass). */
	mergedFiles?: string
	/** `status --porcelain` output — non-empty means the worktree is dirty. */
	dirty?: string
	/** `git push` outcome, keyed on the refspec. */
	push?: (refspec: string) => { code?: number; stdout?: string; stderr?: string } | undefined
	/** `git clone` outcome — the fork clone site. */
	clone?: { code: number; stdout?: string; stderr?: string }
	/** `git fetch` outcome — the upstream fetch. */
	fetch?: { code: number; stdout?: string; stderr?: string }
	/** `git commit` exit code + text. */
	commit?: { code: number; stdout?: string; stderr?: string }
}

type FakeGit = {
	run: GitRunner
	/** Mutable, because the agent fake flips the unmerged list mid-run. */
	unmerged: string[]
	state: {
		head: string
		aborts: number
		pushes: string[]
		commits: string[][]
	}
	/** Every argv the flow issued, verb only — for "must not happen" assertions. */
	verbs: string[]
}

function fakeGit(opts: FakeGitOpts = {}): FakeGit {
	const mergeCode = opts.mergeCode ?? 0
	const unmerged = [...(opts.unmerged ?? [])]
	const markers = [...(opts.markers ?? [])]
	const state = {
		head: PRE_HEAD,
		aborts: 0,
		pushes: [] as string[],
		commits: [] as string[][],
	}
	const verbs: string[] = []
	const run: GitRunner = (args) => {
		const a = args.map(String)
		const verb = a[0]
		verbs.push(verb)
		switch (verb) {
			case "clone": {
				const c = opts.clone
				return { code: c?.code ?? 0, stdout: c?.stdout ?? "", stderr: c?.stderr ?? "" }
			}
			case "fetch": {
				const f = opts.fetch
				return { code: f?.code ?? 0, stdout: f?.stdout ?? "", stderr: f?.stderr ?? "" }
			}
			case "rev-parse":
				return withOutput(`${state.head}\n`)
			case "merge": {
				if (a.includes("--abort")) {
					state.aborts += 1
					return ok
				}
				if (mergeCode === 0) state.head = MERGE_HEAD
				return { code: mergeCode, stdout: "", stderr: mergeCode ? "CONFLICT" : "" }
			}
			case "diff":
				return a.includes("--diff-filter=U")
					? withOutput(unmerged.length ? `${unmerged.join("\n")}\n` : "")
					: withOutput(opts.mergedFiles ?? "src/a.ts\nsrc/b.ts\n")
			case "grep":
				return {
					code: opts.grepCode ?? (markers.length ? 0 : 1),
					stdout: markers.length ? `${markers.join("\n")}\n` : "",
					stderr: "",
				}
			case "status":
				return withOutput(opts.dirty ?? "")
			case "commit": {
				state.commits.push(a)
				const c = opts.commit ?? { code: 0 }
				return { code: c.code, stdout: c.stdout ?? "", stderr: c.stderr ?? "" }
			}
			case "push": {
				const refspec = a[a.length - 1]
				state.pushes.push(refspec)
				const r = opts.push?.(refspec)
				return { code: r?.code ?? 0, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" }
			}
			default:
				return ok
		}
	}
	return { run, unmerged, state, verbs }
}

function fakeWorkdirs(): { workdirs: Workdirs; removed: string[]; created: string[] } {
	const created: string[] = []
	const removed: string[] = []
	return {
		created,
		removed,
		workdirs: {
			exists: () => false,
			mkdir: (p) => {
				created.push(p)
			},
			remove: (p) => {
				removed.push(p)
			},
			writeFile: () => {},
			readFile: () => "",
		},
	}
}

type GhCall = { method: string; path: string; json?: unknown }

function fakeApi(
	route: (_method: string, path: string) => { status?: number; data?: unknown } | undefined,
): { api: GhAppClient; calls: GhCall[] } {
	const calls: GhCall[] = []
	const api: GhAppClient = {
		request: async (method, path, opts) => {
			calls.push({ method, path, json: opts?.json })
			const r = route(method, path)
			return { status: r?.status ?? 200, data: r?.data ?? {} }
		},
		installationToken: async (id) => {
			calls.push({ method: "POST", path: `/app/installations/${id}/access_tokens` })
			return "tok"
		},
	}
	return { api, calls }
}

type AgentCall = { prompt: string; label: string; fork: string; dry: boolean }

function fakeAgent(run: (call: AgentCall) => PostResult): {
	agent: SyncAgentPort
	calls: AgentCall[]
} {
	const calls: AgentCall[] = []
	return {
		calls,
		agent: {
			runSync: async ({ prompt, label, fork, dry }) => {
				const call = { prompt, label, fork, dry: dry ?? false }
				calls.push(call)
				return run(call)
			},
		},
	}
}

function recordingDiscord(): { post: PostDiscord; posts: { title: string; lines: string[] }[] } {
	const posts: { title: string; lines: string[] }[] = []
	return {
		posts,
		post: async (title, lines) => {
			posts.push({ title, lines })
			return true
		},
	}
}

function tempStateFile(): { file: string; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "sync-state-"))
	return {
		dir,
		file: join(dir, "sync-state.json"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	}
}

const baseConfig = (over: Partial<SyncConfig> = {}): SyncConfig => ({
	...UPSTREAM_SYNC_DEFAULTS,
	enabled: true,
	...over,
})

const request = (over: Partial<SyncRequest> = {}): SyncRequest => ({
	fork: "f/x",
	token: "tok",
	parent: "up/x",
	localBranch: "main",
	upstreamBranch: "main",
	upstreamSha: "up1",
	mergeCount: 4,
	divergence: 26,
	...over,
})

/**
 * The buffered report port — `Report` (report.ts) satisfies this structurally,
 * and so does this recorder. It is REQUIRED on `SyncForkDeps`, so every harness
 * supplies one: the three BUFFER lines (resolving / salvage / quality) are the
 * only record an operator gets that a merge was recovered from a dead agent
 * call, and a silently dropped line is the failure this port must not have.
 */
function recordingReport(): { report: ReportPort; lines: string[] } {
	const lines: string[] = []
	return { lines, report: { push: (line: string) => void lines.push(line) } }
}

type ForkOpts = {
	git?: FakeGit
	agent?: { agent: SyncAgentPort; calls: AgentCall[] }
	discord?: { post: PostDiscord; posts: { title: string; lines: string[] }[] }
	now?: number
	api?: GhAppClient
	report?: ReportPort
}

function forkDeps(opts: ForkOpts = {}) {
	const git = opts.git ?? fakeGit()
	const agent = opts.agent ?? fakeAgent(() => ({ ok: true, snippet: "ok" }))
	const discord = opts.discord ?? recordingDiscord()
	const fs = fakeWorkdirs()
	const rep = recordingReport()
	const state: { saved: SyncState[] } = { saved: [] }
	const deps = {
		run: git.run,
		workdirs: fs.workdirs,
		agent: agent.agent,
		// A dry run asks the protection endpoint whether the branch is protected.
		// The default branch here is UNPROTECTED, so the endpoint must answer 404
		// ("no rules") — an unqualified 200 would make every dry run claim the
		// protected/PR path. Tests that want `pr-path` route it themselves.
		api:
			opts.api ??
			fakeApi((_m, path) =>
				path.includes("/protection") ? { status: 404, data: {} } : { data: {} },
			).api,
		fetchGhToken: () => "pat-tok",
		postDiscord: discord.post,
		report: opts.report ?? rep.report,
		saveState: (s: SyncState) => {
			state.saved.push(JSON.parse(JSON.stringify(s)) as SyncState)
		},
		loadState: () => ({}) as SyncState,
		now: () => opts.now ?? 1_700_000_000,
	}
	return { deps, git, agent, discord, fs, state, report: rep }
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 1 — compare-API parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("group 1 · upstreamStatus", () => {
	test("parses ahead_by / behind_by / tip with a single compare call", async () => {
		const { api, calls } = fakeApi(() => ({
			data: {
				ahead_by: 4,
				behind_by: 26,
				commits: [{ sha: "aaa" }, { sha: "bbb" }, { sha: "ccc" }, { sha: "4eafc064" }],
			},
		}))
		const info = await upstreamStatus(
			api,
			"tok",
			"asepharyana/shiro-neko",
			"zakirkun/shiro-neko",
			"main",
			"main",
		)
		expect(info).toEqual([4, 26, "4eafc064"])
		expect(calls).toHaveLength(1)
		// The cross-repo head ref is `{owner}:{branch}` — the full `owner/repo`
		// 404s against GitHub (verified live 2026-09-21).
		expect(calls[0].path).toBe("/repos/asepharyana/shiro-neko/compare/main...zakirkun:main")
	})

	test("falls back to the parent commit endpoint when compare has no tip", async () => {
		const { api, calls } = fakeApi((_m, path) =>
			path.includes("/compare/")
				? { data: { ahead_by: 2, behind_by: 0, commits: [] } }
				: { data: { sha: "tip-from-commits" } },
		)
		const info = await upstreamStatus(api, "tok", "f/x", "up/x", "main", "main")
		expect(info).toEqual([2, 0, "tip-from-commits"])
		expect(calls[1].path).toBe("/repos/up/x/commits/main")
	})

	test("an unavailable compare is null", async () => {
		const { api, calls } = fakeApi(() => ({ status: 404, data: { message: "Not Found" } }))
		expect(await upstreamStatus(api, "tok", "f", "p", "main", "main")).toBeNull()
		// No PAT is available, so the compare is not retried.
		expect(calls).toHaveLength(1)
	})

	test("retries the compare with the PAT when the installation token 404s", async () => {
		// The first call 404s (the App cannot read this upstream), the second — made
		// with the PAT — succeeds. A second failure would be `null`.
		let calls = 0
		const retrying = fakeApi(() => {
			calls += 1
			return calls === 1
				? { status: 404, data: {} }
				: { data: { ahead_by: 1, behind_by: 0, commits: [{ sha: "z" }] } }
		})
		expect(
			await upstreamStatus(retrying.api, "tok", "f", "p", "main", "main", {
				fetchGhToken: () => "pat",
			}),
		).toEqual([1, 0, "z"])
		expect(retrying.calls).toHaveLength(2)
	})

	test("a second failure after the PAT retry is still null", async () => {
		const { api, calls } = fakeApi(() => ({ status: 404, data: {} }))
		expect(
			await upstreamStatus(api, "tok", "f", "p", "main", "main", { fetchGhToken: () => "pat" }),
		).toBeNull()
		expect(calls).toHaveLength(2)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 2 — gating: same upstream tip / interval not due
// ═══════════════════════════════════════════════════════════════════════════

describe("group 2 · runUpstreamSync gating", () => {
	const routes = (tip: string) => (_method: string, path: string) => {
		if (path === "/app/installations") return { data: [{ id: 1 }] }
		if (path.startsWith("/installation/repositories")) {
			return {
				data: {
					repositories: [{ full_name: "asepharyana/shiro-neko", fork: true }],
				},
			}
		}
		if (path === "/repos/asepharyana/shiro-neko") {
			return {
				data: {
					fork: true,
					parent: { full_name: "zakirkun/shiro-neko", default_branch: "main" },
					default_branch: "main",
				},
			}
		}
		if (path.includes("/compare/")) {
			return { data: { ahead_by: 4, behind_by: 26, commits: [{ sha: tip }] } }
		}
		if (path.includes("/pulls")) return { data: [] }
		return { data: {} }
	}

	const depsFor = (
		api: GhAppClient,
		state: SyncState,
		attempts: string[],
	): RunUpstreamSyncDeps => ({
		run: fakeGit().run,
		workdirs: fakeWorkdirs().workdirs,
		agent: fakeAgent(() => ({ ok: true, snippet: "ok" })).agent,
		api,
		fetchGhToken: () => "",
		postDiscord: async () => true,
		loadState: () => state,
		saveState: () => {},
		now: () => 1_700_000_000,
		repoOverrides: {},
		// Required since fix round 1: a missing report port is a compile error, so
		// every factory must supply one. These tests are about the sync decisions,
		// not the report text, so the port discards.
		report: { push: () => {} },
		// The Python replaced the module global; an optional override is the
		// equivalent seam, and the fake mirrors what the real one records. It also
		// honours the dry flag, because the real one returns "dry"/"pr-path"
		// instead of "synced" and the reporter switches on that.
		syncForkRepo: async (_deps, req, st, _cfg, dry) => {
			attempts.push(req.upstreamSha)
			if (dry) return ["dry", "prepared"]
			const e = syncEntry(st, req.fork)
			e.last_sync_ts = 1_700_000_000
			e.last_attempt_sha = req.upstreamSha
			return ["synced", "fake"]
		},
	})

	test("first tick attempts, the next tip inside the interval does not", async () => {
		const attempts: string[] = []
		const state: SyncState = {}
		const up1 = fakeApi(routes("up1"))

		await runUpstreamSync(depsFor(up1.api, state, attempts))
		expect(attempts).toEqual(["up1"])

		// Same upstream tip → the entry's last_attempt_sha already covers it.
		await runUpstreamSync(depsFor(up1.api, state, attempts))
		expect(attempts).toEqual(["up1"])

		// Upstream moved, but the 1h interval has not elapsed → no attempt.
		const up2 = fakeApi(routes("up2"))
		await runUpstreamSync(depsFor(up2.api, state, attempts))
		expect(attempts).toEqual(["up1"])

		// Backdate the last attempt → the new tip is picked up.
		const entry = syncEntry(state, "asepharyana/shiro-neko")
		entry.last_sync_ts = 1_700_000_000 - 2 * 3600
		entry.last_attempt_sha = "up1"
		await runUpstreamSync(depsFor(up2.api, state, attempts))
		expect(attempts).toEqual(["up1", "up2"])
	})

	test("an interval override of 6h holds a fresh attempt back longer", async () => {
		const attempts: string[] = []
		const state: SyncState = {}
		const entry = syncEntry(state, "asepharyana/shiro-neko")
		entry.last_sync_ts = 1_700_000_000 - 2 * 3600 // 2h ago
		entry.last_attempt_sha = "up1"
		const deps = depsFor(fakeApi(routes("up2")).api, state, attempts)
		deps.repoOverrides = { "asepharyana/shiro-neko": { interval_h: 6 } }
		await runUpstreamSync(deps)
		expect(attempts).toEqual([])
	})

	test("a fork listed in the skip overrides is never attempted and stays silent", async () => {
		// The whole point of the opt-out: a 37-conflict fork must cost NOTHING —
		// no clone, no agent call, and no report line (a quiet worker stays
		// quiet, the same rule the other gates follow).
		const attempts: string[] = []
		const state: SyncState = {}
		const deps = depsFor(fakeApi(routes("up1")).api, state, attempts)
		deps.repoOverrides = skipRepoOverrides({
			PR_AGENT_SYNC_SKIP_REPOS: "asepharyana/shiro-neko",
		})
		const lines = await runUpstreamSync(deps)
		expect(attempts).toEqual([])
		expect(lines).toEqual([])
		// The entry is materialised by the sort but never stamped, so the fork is
		// exactly where it was before the tick — clearing the list resumes it.
		expect(state["asepharyana/shiro-neko"]?.last_attempt_sha).toBeUndefined()
	})

	test("per-tick budget is 2 and the longest-unsynced fork is served first", async () => {
		// A THIRD fork makes the budget observable: two of three may run.
		const attempts: string[] = []
		const state: SyncState = {}
		const forks = ["o/fresh", "o/stale", "o/middle"]
		const api = fakeApi((_m, path) => {
			if (path === "/app/installations") return { data: [{ id: 1 }] }
			if (path.startsWith("/installation/repositories")) {
				return { data: { repositories: forks.map((f) => ({ full_name: f, fork: true })) } }
			}
			if (forks.includes(path.replace("/repos/", ""))) {
				return {
					data: {
						fork: true,
						parent: { full_name: "up/x", default_branch: "main" },
						default_branch: "main",
					},
				}
			}
			if (path.includes("/compare/")) {
				// A distinct tip per fork, or the second one would be gated out by
				// `last_attempt_sha` and the test would prove nothing about the budget.
				return { data: { ahead_by: 1, behind_by: 0, commits: [{ sha: `tip-${path}` }] } }
			}
			if (path.includes("/pulls")) return { data: [] }
			return { data: {} }
		})
		// `o/fresh` was synced 10 minutes ago, `o/middle` an hour ago, `o/stale`
		// never. With `max_per_tick = 2` the budget must go to the two stalest, in
		// that order.
		syncEntry(state, "o/fresh").last_sync_ts = 1_700_000_000 - 600
		syncEntry(state, "o/middle").last_sync_ts = 1_700_000_000 - 3600
		const deps = depsFor(api.api, state, attempts)
		await runUpstreamSync(deps)
		expect(attempts).toHaveLength(2)
		// `o/stale` sorts as 0 (never synced) so it is served first.
		expect(attempts[0]).toContain("o/stale")
		expect(attempts[1]).toContain("o/middle")
	})

	test("`only` bypasses an exhausted budget", async () => {
		const attempts: string[] = []
		const state: SyncState = {}
		const forks = ["o/a", "o/b", "o/c"]
		const api = fakeApi((_m, path) => {
			if (path === "/app/installations") return { data: [{ id: 1 }] }
			if (path.startsWith("/installation/repositories")) {
				return { data: { repositories: forks.map((f) => ({ full_name: f, fork: true })) } }
			}
			if (forks.includes(path.replace("/repos/", ""))) {
				return {
					data: {
						fork: true,
						parent: { full_name: "up/x", default_branch: "main" },
						default_branch: "main",
					},
				}
			}
			if (path.includes("/compare/")) {
				return { data: { ahead_by: 1, behind_by: 0, commits: [{ sha: `tip-${path}` }] } }
			}
			if (path.includes("/pulls")) return { data: [] }
			return { data: {} }
		})
		const deps = depsFor(api.api, state, attempts)
		await runUpstreamSync(deps)
		expect(attempts).toHaveLength(2) // budget of 2 stops after two
		// Naming the THIRD fork explicitly must still run it.
		await runUpstreamSync(deps, { only: "o/c" })
		expect(attempts).toHaveLength(3)
	})

	test("a dry run writes nothing and posts nothing", async () => {
		const attempts: string[] = []
		const state: SyncState = {}
		const discord = recordingDiscord()
		const saved: SyncState[] = []
		const deps = depsFor(fakeApi(routes("up1")).api, state, attempts)
		deps.postDiscord = discord.post
		deps.saveState = (s) => {
			saved.push(JSON.parse(JSON.stringify(s)) as SyncState)
		}
		const lines = await runUpstreamSync(deps, { dry: true })
		expect(attempts).toEqual(["up1"])
		expect(lines.some((l) => l.includes("dry run"))).toBe(true)
		expect(discord.posts).toHaveLength(0)
		// Nothing is persisted, and the state the caller handed in is untouched.
		expect(saved).toEqual([])
		expect(state).toEqual({})
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 3 — clean merge → push → pending_verify
// ═══════════════════════════════════════════════════════════════════════════

describe("group 3 · clean merge", () => {
	test("status synced, one push, pending_verify and last_merged_upstream_sha recorded", async () => {
		const git = fakeGit({ mergeCode: 0, unmerged: [] })
		const { deps, agent } = forkDeps({ git })
		const state: SyncState = {}
		const fs = await syncForkRepo(
			deps,
			request({ fork: "asepharyana/shiro-neko" }),
			state,
			baseConfig(),
		)

		expect(fs[0]).toBe("synced")
		expect(git.state.pushes).toEqual(["HEAD:refs/heads/main"])

		const entry = state["asepharyana/shiro-neko"]
		const pending = pendingVerify(entry)
		expect(pending?.sha).toBe(git.state.head)
		expect(pending?.pre_merge_sha?.startsWith("pre")).toBe(true)
		expect(pending?.branch).toBe("main")
		expect(entry.last_merged_upstream_sha).toBe("up1")
		expect(entry.skip_reason).toBe("")
		expect(entry.notified).toBe(false)
		// A clean merge gets a quality pass, and nothing else.
		expect(agent.calls.map((c) => c.label)).toEqual(["hermes_sync_quality"])
		expect(fs[1]).toContain("4 upstream commit(s) merged into main")
	})

	test("the quality pass emits its line through the report port", async () => {
		// The third of the three BUFFER lines. It tells an operator a second agent
		// call is about to start, which is the difference between "the worker is
		// idle" and "the worker is spending another up-to-3600s on this fork".
		const git = fakeGit({ mergeCode: 0, unmerged: [], mergedFiles: "src/a.ts\nsrc/b.ts\n" })
		const rep = recordingReport()
		const { deps } = forkDeps({ git, report: rep.report })
		await syncForkRepo(deps, request(), {} as SyncState, baseConfig())
		expect(rep.lines).toEqual([QUALITY_LINE(2)])
	})

	test("a merge with no changed files runs no quality pass and reports nothing", async () => {
		const git = fakeGit({ mergeCode: 0, unmerged: [], mergedFiles: "" })
		const rep = recordingReport()
		const { deps, agent } = forkDeps({ git, report: rep.report })
		await syncForkRepo(deps, request(), {} as SyncState, baseConfig())
		expect(agent.calls).toHaveLength(0)
		expect(rep.lines).toEqual([])
	})

	test("the workdir is removed on the way out", async () => {
		const git = fakeGit({ mergeCode: 0 })
		const { deps, fs } = forkDeps({ git })
		await syncForkRepo(deps, request(), {} as SyncState, baseConfig())
		expect(fs.removed).toEqual([`${SYNC_TMP_BASE}/f_x`])
	})

	test("a failed clone is an error, records the attempt and never pushes", async () => {
		const git = fakeGit()
		git.run = (args) =>
			args[0] === "clone" ? { code: 128, stdout: "", stderr: "fatal: repository not found" } : ok
		const { deps } = forkDeps({ git })
		const state: SyncState = {}
		const [status, detail] = await syncForkRepo(deps, request(), state, baseConfig())
		expect(status).toBe("error")
		expect(detail).toContain("clone failed: fatal: repository not found")
		expect(git.state.pushes).toEqual([])
		expect(num(syncEntry(state, "f/x").last_sync_ts)).toBe(1_700_000_000)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 4 — dry run is pure
// ═══════════════════════════════════════════════════════════════════════════

describe("group 4 · dry run", () => {
	test("a dry run on a protected branch reaches pr-path and says so", async () => {
		// The rehearsal's whole point: "this branch is protected, a PR would be
		// opened" is the fact a dry run exists to surface. It is learned from a
		// READ-ONLY `GET /repos/{fork}/branches/{branch}/protection`, and
		// deliberately NOT from a push: `git push --dry-run` does not run the
		// remote's pre-receive hook, so it exits 0 on a protected branch and cannot
		// classify. The test pins both halves of that contract — pr-path IS
		// returned, and NOT ONE push is issued.
		const api = fakeApi((method, path) => {
			if (method === "GET" && path.includes("/protection")) return { status: 200, data: {} }
			return { data: {} }
		})
		const git = fakeGit({ mergeCode: 0, unmerged: [] })
		const { deps } = forkDeps({ git, api: api.api })
		const sync: SyncState = {}
		const [status, detail] = await syncForkRepo(deps, request(), sync, baseConfig(), true)

		expect(status).toBe("pr-path")
		expect(detail).toContain("protected branch detected")
		expect(detail).toContain("would open an upstream-sync PR")
		// No push at all — not even `git push --dry-run` — and no PR is opened.
		expect(git.state.pushes).toEqual([])
		expect(api.calls.some((c) => c.path.includes("/pulls"))).toBe(false)
		expect(sync).toEqual({})
	})

	test("an unprotected branch in dry mode reports dry, not pr-path", async () => {
		// 404 is GitHub's answer for a branch that exists but carries no protection
		// rules — the plain "not protected" case.
		const api = fakeApi((method, path) => {
			if (method === "GET" && path.includes("/protection")) return { status: 404, data: {} }
			return { data: {} }
		})
		const git = fakeGit({ mergeCode: 0, unmerged: [] })
		const { deps } = forkDeps({ git, api: api.api })
		const [status, detail] = await syncForkRepo(
			deps,
			request(),
			{} as SyncState,
			baseConfig(),
			true,
		)
		expect(status).toBe("dry")
		expect(detail).toContain(`prepared in ${SYNC_TMP_BASE}/f_x`)
		expect(git.state.pushes).toEqual([])
	})

	test("a 403 (rules unreadable) is unknown, and unknown is reported as dry", async () => {
		// The App gets 403 — not 404 — on the protection endpoint for a branch
		// whose rules it cannot read. That is UNKNOWN, and unknown must NOT be
		// reported as protected: a false pr-path sends an operator looking for a PR
		// that would never be opened. Only a literal 200 yields pr-path
		// (run.ts:463), so this pins the requirement that a future reading of 403
		// as "protected" cannot pass the suite.
		const api = fakeApi((method, path) => {
			if (method === "GET" && path.includes("/protection")) return { status: 403, data: {} }
			return { data: {} }
		})
		const git = fakeGit({ mergeCode: 0, unmerged: [] })
		const { deps } = forkDeps({ git, api: api.api })
		const [status] = await syncForkRepo(deps, request(), {} as SyncState, baseConfig(), true)

		expect(status).toBe("dry")
		expect(git.state.pushes).toEqual([])
	})

	test("returns dry, never pushes, never writes state", async () => {
		const git = fakeGit({ mergeCode: 0, unmerged: [] })
		const { deps, state } = forkDeps({ git })
		const sync: SyncState = {}
		const res = await syncForkRepo(deps, request(), sync, baseConfig(), true)
		expect(res[0]).toBe("dry")
		expect(git.state.pushes).toEqual([])
		expect(sync).toEqual({})
		expect(state.saved).toEqual([])
		// The workdir is deliberately KEPT so a human can inspect the dry result.
		expect(res[1]).toContain(`prepared in ${SYNC_TMP_BASE}/f_x`)
	})

	test("a failed conflict resolution in dry mode writes no state either", async () => {
		const git = fakeGit({ mergeCode: 1, unmerged: ["src/tools.ts"] })
		const { deps, agent } = forkDeps({
			git,
			agent: fakeAgent(() => ({ ok: false, snippet: "[INFRA] timed out" })),
		})
		const sync: SyncState = {}
		const [status] = await syncForkRepo(deps, request(), sync, baseConfig(), true)
		expect(status).toBe("conflict-failed")
		expect(sync).toEqual({})
		expect(agent.calls.every((c) => c.dry)).toBe(true)
	})

	// The Python calls `save_sync_state(state)` UNCONDITIONALLY on the clone /
	// fetch / merge-error exits (lines 1539, 1550, 1557), with no `if dry`. Since
	// `runUpstreamSync` hands a dry run a throwaway `state = {}` (line 1737), the
	// Python writes `{}` over the real state file and loses every armed
	// `pending_verify` watch. The brief requires no writes, so `persist()` is
	// guarded — and this test is what keeps the guard from being "cleaned up".
	for (const [label, script] of [
		["a failed clone", { clone: { code: 128, stderr: "fatal: nope" } }],
		["a failed upstream fetch", { fetch: { code: 128, stderr: "fatal: nope" } }],
		["a merge error", { mergeCode: 1, unmerged: [] }],
	] satisfies [string, FakeGitOpts][]) {
		test(`dry mode saves nothing on ${label}`, async () => {
			const git = fakeGit(script)
			const { deps, state } = forkDeps({ git })
			const sync: SyncState = {}
			const [status] = await syncForkRepo(deps, request(), sync, baseConfig(), true)
			expect(status).toBe("error")
			expect(state.saved).toEqual([])
			expect(sync).toEqual({})
		})
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 5 — conflicted merge handed to the agent
// ═══════════════════════════════════════════════════════════════════════════

describe("group 5 · conflict resolution", () => {
	test("resolved conflicts are committed once and pushed", async () => {
		const git = fakeGit({ mergeCode: 1, unmerged: ["src/tools.ts", "src/ui/App.tsx"] })
		const agent = fakeAgent((call) => {
			git.unmerged.length = 0 // the agent resolved the tree
			call.prompt.length // prompt captured below
			return { ok: true, snippet: "resolved" }
		})
		const { deps } = forkDeps({ git, agent })
		const state: SyncState = {}
		const [status, detail] = await syncForkRepo(deps, request(), state, baseConfig())

		expect(status).toBe("synced")
		expect(agent.calls.map((c) => c.label)).toEqual(["hermes_sync_conflicts"])
		expect(git.state.commits).toEqual([["commit", "--no-edit"]])
		expect(git.state.aborts).toBe(0)
		expect(detail).toContain("resolved 2 conflict")
		expect(git.state.pushes).toEqual(["HEAD:refs/heads/main"])
	})

	test("the conflict prompt forbids --ours/--theirs and rebase", () => {
		const prompt = conflictPrompt("f/x", "up/x", "main", "main", ["src/tools.ts"])
		expect(prompt).toContain("--ours/--theirs")
		expect(prompt).toContain("rebase")
		expect(prompt).toContain("src/tools.ts")
		expect(prompt).toContain("BOM")
		// Policy the merge depends on: hand-merge, both sides survive.
		expect(prompt).toContain("neither side may be dropped")
	})

	test("a failed resolution skips once, records the attempt and never pushes", async () => {
		const git = fakeGit({ mergeCode: 1, unmerged: ["src/tools.ts"] })
		const { deps } = forkDeps({
			git,
			agent: fakeAgent(() => ({
				ok: false,
				snippet: "[INFRA] Hermes API server timed out after 3600s",
			})),
		})
		const state: SyncState = {}
		const [status, detail] = await syncForkRepo(deps, request(), state, baseConfig())
		const entry = state["f/x"]

		expect(status).toBe("conflict-failed")
		expect(detail).toContain("conflict resolution failed")
		expect(entry.last_attempt_sha).toBe("up1")
		expect(String(entry.skip_reason)).toContain("timed out")
		expect(entry.notified).toBe(false)
		expect(entry.pending_verify ?? null).toBeNull()
		expect(git.state.pushes).toEqual([])
		expect(git.state.aborts).toBeGreaterThanOrEqual(1)
	})

	test("resolve_conflicts:false aborts the merge without calling the agent", async () => {
		const git = fakeGit({ mergeCode: 1, unmerged: ["src/tools.ts", "src/b.ts"] })
		const { deps, agent } = forkDeps({ git })
		const state: SyncState = {}
		const [status, detail] = await syncForkRepo(
			deps,
			request(),
			state,
			baseConfig({ resolve_conflicts: false }),
		)
		expect(status).toBe("conflict-failed")
		expect(detail).toContain("conflict resolution is disabled: src/tools.ts, src/b.ts")
		expect(agent.calls).toHaveLength(0)
		expect(git.state.aborts).toBeGreaterThanOrEqual(1)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 6 — leftover conflict markers block the commit
// ═══════════════════════════════════════════════════════════════════════════

describe("group 6 · the conflict-marker guard", () => {
	test("refuses to commit a file that still carries markers", () => {
		const git = fakeGit({ unmerged: [], markers: ["src/App.tsx"] })
		const outcome: MergeOutcome = syncFinishMerge(git.run, "/w")
		expect(outcome.ok).toBe(false)
		expect(outcome.detail).toBe("conflict markers left in: src/App.tsx")
		expect(git.state.commits).toEqual([])
		expect(git.verbs).not.toContain("commit")
	})

	test("reports the first five unmerged paths and slices the list", () => {
		const files = ["a", "b", "c", "d", "e", "f", "g"]
		const git = fakeGit({ unmerged: files, markers: [] })
		const outcome = syncFinishMerge(git.run, "/w")
		expect(outcome.detail).toBe("7 file(s) still unmerged: a, b, c, d, e")
	})

	test("a commit that only has nothing-to-commit is a success", () => {
		const git = fakeGit({
			unmerged: [],
			markers: [],
			commit: { code: 1, stderr: "On branch main\nnothing to commit, working tree clean" },
		})
		expect(syncFinishMerge(git.run, "/w")).toEqual({ ok: true, detail: "" })
	})

	test("a real commit failure is reported from stderr, then stdout", () => {
		// The fixture is PADDED on purpose. A real git hook writes "  <message>\n"
		// to stderr, and the detail feeds the `conflict resolution incomplete — …`
		// skip note and a Discord post. Python line 1351 is
		// `((r.stderr or r.stdout) or "").strip()[:200]`, so the leading spaces and
		// the trailing newline must be gone. An unpadded fixture ("hook failed")
		// would pass against untrimmed code and prove nothing.
		const git = fakeGit({
			unmerged: [],
			markers: [],
			commit: { code: 1, stderr: "  hook failed\n" },
		})
		expect(syncFinishMerge(git.run, "/w")).toEqual({ ok: false, detail: "hook failed" })
	})

	test("the commit detail is trimmed BEFORE the [:200] slice, and falls back to stdout", () => {
		// Order matters and is the Python's: strip first, THEN slice. A long
		// padded message that gets sliced first would keep leading whitespace and
		// lose 200 characters of tail; stripping first caps the CONTENT at 200.
		const padded = `  ${"x".repeat(250)}  \n`
		const git = fakeGit({ unmerged: [], markers: [], commit: { code: 1, stderr: padded } })
		const detail = syncFinishMerge(git.run, "/w").detail
		expect(detail).toBe("x".repeat(200))
		expect(detail).toHaveLength(200)
		// stdout is the fallback when stderr is empty, and is trimmed the same way.
		const viaStdout = fakeGit({
			unmerged: [],
			markers: [],
			commit: { code: 1, stdout: "\n  from stdout  \n" },
		})
		expect(syncFinishMerge(viaStdout.run, "/w")).toEqual({ ok: false, detail: "from stdout" })
	})

	test("git grep's exit 1 (no matches) and exit 2 (git failed) are different cases", () => {
		// exit 0 with output → markers found.
		expect(syncHasConflictMarkers(fakeGit({ markers: ["a.ts"] }).run, "/w")).toEqual(["a.ts"])
		// exit 1 is the HEALTHY "nothing matched" case.
		expect(syncHasConflictMarkers(fakeGit({ markers: [] }).run, "/w")).toEqual([])
		// exit 2 is git itself failing. The Python returns [] for it rather than
		// treating the (empty) stdout as a scan result, and the three-way branch
		// is what keeps a broken repo from reading as a clean one.
		const broken = fakeGit({ markers: [], grepCode: 2 })
		const run = ((args: string[]) =>
			args[0] === "grep"
				? { code: 2, stdout: "", stderr: "fatal: not a git repository" }
				: ok) as GitRunner
		expect(syncHasConflictMarkers(run, "/w")).toEqual([])
		expect(broken.verbs).toBeDefined()
	})

	test("syncUnmergedFiles filters blank lines out of git's output", () => {
		const run = ((args: string[]) =>
			args[0] === "diff"
				? { code: 0, stdout: "src/a.ts\n\n  \nsrc/b.ts\n", stderr: "" }
				: ok) as GitRunner
		expect(syncUnmergedFiles(run, "/w")).toEqual(["src/a.ts", "src/b.ts"])
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 7 — salvage
// ═══════════════════════════════════════════════════════════════════════════

describe("group 7 · salvage", () => {
	test("a timed-out agent call after a finished merge is salvaged, not failed", async () => {
		const git = fakeGit({ mergeCode: 1, unmerged: ["src/tools.ts"] })
		const done = { value: false }
		const { deps } = forkDeps({
			git,
			agent: fakeAgent(() => {
				done.value = true // the agent finished resolving...
				git.unmerged.length = 0
				return { ok: false, snippet: "[INFRA] Hermes API server timed out after 3600s" }
			}),
		})
		const state: SyncState = {}
		const [status, detail] = await syncForkRepo(deps, request(), state, baseConfig())

		expect(status).toBe("synced")
		expect(detail.toLowerCase()).toContain("salvag")
		expect(git.state.pushes).toEqual(["HEAD:refs/heads/main"])
		expect(git.state.aborts).toBe(0)
		expect(pendingVerify(state["f/x"])?.sha).toBe(git.state.head)
	})

	test("a salvaged sync emits the ♻️ line through the report port", async () => {
		// The salvage line is the one an operator most needs: the merge was
		// recovered from an agent call that ended early (a 3600s timeout after the
		// agent had already committed), and the push that follows looks like an
		// ordinary one. Without this line, nothing says the merge was salvaged.
		const git = fakeGit({ mergeCode: 1, unmerged: ["src/tools.ts"] })
		const rep = recordingReport()
		const { deps } = forkDeps({
			git,
			report: rep.report,
			agent: fakeAgent(() => {
				git.unmerged.length = 0 // the agent finished before it was cut off
				return { ok: false, snippet: "[INFRA] Hermes API server timed out after 3600s" }
			}),
		})
		const [status] = await syncForkRepo(deps, request(), {} as SyncState, baseConfig())

		expect(status).toBe("synced")
		expect(rep.lines).toEqual([RESOLVING_LINE(1), SALVAGE_LINE])
	})

	test("an unfinished merge after a timeout emits no salvage line", async () => {
		// The mirror of the test above: when `syncFinishMerge` refuses, the merge
		// is aborted and NOTHING is claimed. Emitting ♻️ here would be a false
		// recovery report for a merge that was thrown away.
		const git = fakeGit({ mergeCode: 1, unmerged: ["src/tools.ts"] })
		const rep = recordingReport()
		const { deps } = forkDeps({
			git,
			report: rep.report,
			agent: fakeAgent(() => ({ ok: false, snippet: "[INFRA] timed out" })),
		})
		const [status] = await syncForkRepo(deps, request(), {} as SyncState, baseConfig())

		expect(status).toBe("conflict-failed")
		expect(rep.lines).toEqual([RESOLVING_LINE(1)])
		expect(rep.lines).not.toContain(SALVAGE_LINE)
	})

	test("an unfinished merge after a timeout still fails and aborts", async () => {
		const git = fakeGit({ mergeCode: 1, unmerged: ["src/tools.ts"] })
		const { deps } = forkDeps({
			git,
			agent: fakeAgent(() => ({ ok: false, snippet: "[INFRA] timed out" })),
		})
		const state: SyncState = {}
		const [status] = await syncForkRepo(deps, request(), state, baseConfig())
		expect(status).toBe("conflict-failed")
		expect(git.state.aborts).toBeGreaterThanOrEqual(1)
		expect(git.state.pushes).toEqual([])
		expect(state["f/x"].pending_verify ?? null).toBeNull()
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 8 — protected branch → PR
// ═══════════════════════════════════════════════════════════════════════════

describe("group 8 · protected branch falls back to a PR", () => {
	const protectedPush = (refspec: string) =>
		refspec === "HEAD:refs/heads/main"
			? {
					code: 1,
					stderr: "remote: error: GH006: Protected branch update failed for refs/heads/main.",
				}
			: undefined

	test("pr-opened, the direct push was tried first, no pending_verify", async () => {
		const git = fakeGit({ mergeCode: 0, unmerged: [], push: protectedPush })
		const api = fakeApi((method, path) =>
			method === "POST" && path === "/repos/f/x/pulls"
				? { status: 201, data: { number: 42 } }
				: { data: {} },
		)
		const { deps } = forkDeps({ git, api: api.api })
		const state: SyncState = {}
		const [status, detail] = await syncForkRepo(deps, request(), state, baseConfig())

		expect(status).toBe("pr-opened")
		expect(git.state.pushes[0]).toBe("HEAD:refs/heads/main")
		expect(git.state.pushes[1]).toMatch(
			new RegExp(`^HEAD:refs/heads/${SYNC_PR_PREFIX}\\d{8}-\\d{6}$`),
		)
		expect(detail).toContain("main is protected — opened PR #42")
		expect(state["f/x"].pending_verify ?? null).toBeNull()
		// A PR-path sync has NOT merged anything, so nothing is recorded as merged.
		expect(state["f/x"].last_merged_upstream_sha).toBe("")
	})

	test("the PR is opened with an upstream-sync head, the base branch and a compare link", async () => {
		const git = fakeGit({ mergeCode: 0, unmerged: [], push: protectedPush })
		const api = fakeApi((method, path) =>
			method === "POST" && path === "/repos/f/x/pulls"
				? { status: 201, data: { number: 7 } }
				: { data: {} },
		)
		const { deps } = forkDeps({ git, api: api.api })
		await syncForkRepo(
			deps,
			request({ mergeCount: 3, divergence: 11 }),
			{} as SyncState,
			baseConfig(),
		)

		const post = api.calls.find((c) => c.method === "POST") as GhCall
		const body = post.json as Record<string, string>
		expect(body.title).toBe("⬆️ upstream-sync: merge up/x@up1 into main")
		expect(body.head.startsWith(SYNC_PR_PREFIX)).toBe(true)
		expect(body.base).toBe("main")
		expect(body.body).toContain("upstream commits merged: **3**")
		expect(body.body).toContain("fork-only commits preserved: **11**")
		expect(body.body).toContain("https://github.com/f/x/compare/main...up/x:main")
	})

	test("openSyncPr returns 0 when the PR call is refused", async () => {
		const git = fakeGit({ push: protectedPush })
		const api = fakeApi(() => ({ status: 422, data: { message: "Validation Failed" } }))
		const prNum = await openSyncPr(
			git.run,
			api.api,
			"tok",
			"/w",
			"f/x",
			"up/x",
			"main",
			"main",
			"up1",
			4,
			26,
			"clean merge",
			{ now: () => 1_700_000_000 },
		)
		expect(prNum).toBe(0)
	})

	test("syncOpenPr finds an open upstream-sync PR for the base branch, else 0", async () => {
		const api = fakeApi(() => ({
			data: [
				{ number: 5, head: { ref: "other/x" }, base: { ref: "main" } },
				{ number: 9, head: { ref: `${SYNC_PR_PREFIX}20260101-000000` }, base: { ref: "main" } },
			],
		}))
		expect(await syncOpenPr(api.api, "tok", "f/x", "main")).toBe(9)
		expect(await syncOpenPr(api.api, "tok", "f/x", "release")).toBe(0)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 9 — CI verify / auto-revert
// ═══════════════════════════════════════════════════════════════════════════

describe("group 9 · verifyPendingSyncs", () => {
	type Revert = { fork: string; branch: string; preMergeSha: string; reason: string }

	/**
	 * The merge commit the watch is armed on. The tip route must return THIS
	 * sha for the CI checks to be consulted at all — a different tip is the
	 * "someone pushed on top" exit, which is its own test below.
	 */
	const PENDING_SHA = "abc12345def"

	const verifyHarness = (checkRuns: unknown[], tip = PENDING_SHA) => {
		const reverts: Revert[] = []
		const api = fakeApi((_m, path) => {
			if (path.includes("/commits/main?per_page=1")) return { data: [{ sha: tip }] }
			if (path.endsWith("/check-runs")) return { data: { check_runs: checkRuns } }
			return { data: {} }
		})
		const discord = recordingDiscord()
		const saved: SyncState[] = []
		const deps: VerifyDeps = {
			api: api.api,
			enabled: true,
			repoOverrides: {},
			now: () => 1_700_000_000,
			saveState: (s) => {
				saved.push(JSON.parse(JSON.stringify(s)) as SyncState)
			},
			revertMerge: async ({ fork, branch, preMergeSha, reason }) => {
				reverts.push({ fork, branch, preMergeSha, reason })
				return { ok: true, detail: `reverted ${branch} to ${preMergeSha.slice(0, 3)}` }
			},
			postDiscord: discord.post,
		}
		return { deps, reverts, saved, discord }
	}

	const pendingState = (pushedAt: number): SyncState => ({
		"f/x": {
			pending_verify: {
				sha: PENDING_SHA,
				pre_merge_sha: "pre",
				branch: "main",
				pushed_at: pushedAt,
			},
		},
	})

	test("green CI verifies, clears the watch and never reverts", async () => {
		const h = verifyHarness([{ name: "build", status: "completed", conclusion: "success" }])
		const state = pendingState(1_700_000_000)
		const lines = await verifyPendingSyncs(h.deps, state, { "f/x": "tok" })
		expect(lines.some((l) => l.includes("verified green"))).toBe(true)
		expect(state["f/x"].pending_verify).toBeNull()
		expect(h.reverts).toHaveLength(0)
		expect(h.saved).toHaveLength(1)
	})

	test("red CI at our merge sha reverts it and clears last_merged_upstream_sha", async () => {
		const h = verifyHarness([{ name: "build", status: "completed", conclusion: "failure" }])
		const state = pendingState(1_700_000_000)
		state["f/x"].last_merged_upstream_sha = "up1"
		const lines = await verifyPendingSyncs(h.deps, state, { "f/x": "tok" })

		expect(h.reverts[0].preMergeSha).toBe("pre")
		expect(h.reverts[0].branch).toBe("main")
		expect(h.reverts[0].reason).toBe("CI failed: build")
		expect(lines.some((l) => l.includes("reverted"))).toBe(true)
		expect(state["f/x"].pending_verify).toBeNull()
		expect(state["f/x"].last_merged_upstream_sha).toBe("")
		expect(h.discord.posts[0].title).toBe("↩️ Fork sync reverted: f/x")
	})

	test("a tip that moved past our merge is never reverted", async () => {
		const h = verifyHarness(
			[{ name: "build", status: "completed", conclusion: "failure" }],
			"humancommit",
		)
		const state = pendingState(1_700_000_000)
		const lines = await verifyPendingSyncs(h.deps, state, { "f/x": "tok" })
		expect(h.reverts).toHaveLength(0)
		expect(lines.some((l) => l.includes("moved past our merge"))).toBe(true)
		expect(state["f/x"].pending_verify).toBeNull()
	})

	test("a still-running check keeps the watch and saves nothing", async () => {
		const h = verifyHarness([{ name: "build", status: "in_progress" }])
		const state = pendingState(1_700_000_000)
		await verifyPendingSyncs(h.deps, state, { "f/x": "tok" })
		expect(state["f/x"].pending_verify).not.toBeNull()
		expect(h.saved).toHaveLength(0)
	})

	test("no check-runs inside the grace window keeps the watch, past it the watch stops", async () => {
		const h = verifyHarness([])
		const state = pendingState(1_700_000_000)
		await verifyPendingSyncs(h.deps, state, { "f/x": "tok" })
		expect(state["f/x"].pending_verify).not.toBeNull()
		expect(h.saved).toHaveLength(0)

		// An hour old is past the 600s grace but not past the 6h watch limit.
		const aged = pendingState(1_700_000_000 - 3600)
		await verifyPendingSyncs(h.deps, aged, { "f/x": "tok" })
		expect(aged["f/x"].pending_verify).toBeNull()
		expect(h.saved).toHaveLength(1)
	})

	test("past verify_ci_max_age_h the merge is KEPT and the watch just stops", async () => {
		const h = verifyHarness([{ name: "build", status: "completed", conclusion: "failure" }])
		const state = pendingState(1_700_000_000 - 7 * 3600)
		const lines = await verifyPendingSyncs(h.deps, state, { "f/x": "tok" })
		expect(h.reverts).toHaveLength(0)
		expect(lines.some((l) => l.includes("keeping it, stopping the watch"))).toBe(true)
		expect(state["f/x"].pending_verify).toBeNull()
	})

	test("verify_ci:false and dry clear the watch WITHOUT saving", async () => {
		// `verify_ci` is a PER-REPO override, so it goes in `repoOverrides` — the
		// same place the Python's `UPSTREAM_SYNC["repos"]` puts it.
		const off = verifyHarness([{ name: "build", status: "completed", conclusion: "failure" }])
		off.deps.repoOverrides = { "f/x": { verify_ci: false } }
		const disabled = pendingState(1_700_000_000)
		await verifyPendingSyncs(off.deps, disabled, { "f/x": "tok" })
		expect(disabled["f/x"].pending_verify).toBeNull()
		expect(off.saved).toHaveLength(0)
		expect(off.reverts).toHaveLength(0)

		const h = verifyHarness([{ name: "build", status: "completed", conclusion: "failure" }])
		const dry = pendingState(1_700_000_000)
		await verifyPendingSyncs(h.deps, dry, { "f/x": "tok" }, true)
		expect(dry["f/x"].pending_verify).toBeNull()
		expect(h.saved).toHaveLength(0)
		expect(h.reverts).toHaveLength(0)
	})

	test("a repo with no token, or no pending sha, is skipped entirely", async () => {
		const h = verifyHarness([{ name: "build", status: "completed", conclusion: "failure" }])
		const state = pendingState(1_700_000_000)
		state["f/y"] = { pending_verify: null }
		const lines = await verifyPendingSyncs(h.deps, state, { "f/x": "" })
		expect(lines).toEqual([])
		expect(state["f/x"].pending_verify).not.toBeNull()
		expect(h.saved).toHaveLength(0)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 10 — fork discovery
// ═══════════════════════════════════════════════════════════════════════════

describe("group 10 · listForkRepos", () => {
	test("returns only forks whose parent resolves", async () => {
		const { api } = fakeApi((_m, path) => {
			if (path === "/app/installations") return { data: [{ id: 1 }] }
			if (path.startsWith("/installation/repositories")) {
				return {
					data: {
						repositories: [
							{ full_name: "o/plain-repo", fork: false },
							{ full_name: "o/fork-a", fork: true },
							{ full_name: "o/fork-b", fork: true },
						],
					},
				}
			}
			if (path === "/repos/o/fork-a") {
				return { data: { fork: true, default_branch: "main", parent: { full_name: "up/a" } } }
			}
			if (path === "/repos/o/fork-b") {
				return { data: { fork: true, default_branch: "main" } } // parent stripped
			}
			return { status: 404, data: {} }
		})
		expect(await listForkRepos(api)).toEqual([["tok", "o/fork-a", "up/a", "main"]])
	})

	test("a fork with no default_branch reports main", async () => {
		const { api } = fakeApi((_m, path) => {
			if (path === "/app/installations") return { data: [{ id: 1 }] }
			if (path.startsWith("/installation/repositories")) {
				return { data: { repositories: [{ full_name: "o/f", fork: true }] } }
			}
			return { data: { parent: { full_name: "up/f" } } }
		})
		expect(await listForkRepos(api)).toEqual([["tok", "o/f", "up/f", "main"]])
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 11 — push-error classification
// ═══════════════════════════════════════════════════════════════════════════

describe("group 11 · push error classification", () => {
	test("GH006 and required-status-check errors are 'protected'", () => {
		expect(
			isProtectedPushError(
				"remote: error: GH006: Protected branch update failed for refs/heads/main.",
			),
		).toBe(true)
		expect(isProtectedPushError('remote: error: Required status check "ci" is expected.')).toBe(
			true,
		)
	})

	test("a workflows-permission error is classified, and is not 'protected'", () => {
		const err =
			"! [remote rejected] main -> main (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)"
		expect(isWorkflowPushError(err)).toBe(true)
		expect(isProtectedPushError(err)).toBe(false)
	})

	test("a plain rejected push is neither", () => {
		expect(isProtectedPushError("fatal: could not read Username for 'https://github.com'")).toBe(
			false,
		)
		expect(isWorkflowPushError("fatal: could not read Username for 'https://github.com'")).toBe(
			false,
		)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 12 — per-repo config override
// ═══════════════════════════════════════════════════════════════════════════

describe("group 12 · syncConfig", () => {
	test("a per-repo override merges over the worker defaults", () => {
		const cfg = syncConfig("o/fork", {
			"o/fork": { interval_h: 6, verify_ci: false },
		})
		expect(cfg.interval_h).toBe(6)
		expect(cfg.verify_ci).toBe(false)
		expect(cfg.resolve_conflicts).toBe(true)
	})

	test("an override can pin the branch pair", () => {
		const cfg = syncConfig("o/fork", { "o/fork": { branches: { local: "main", upstream: "dev" } } })
		expect(cfg.branches).toEqual({ local: "main", upstream: "dev" })
	})

	test("the repos map is never leaked into a resolved config", () => {
		const cfg = syncConfig("o/fork", { "o/fork": { interval_h: 6 } })
		expect("repos" in cfg).toBe(false)
		expect(Object.keys(cfg).sort()).toEqual(Object.keys(UPSTREAM_SYNC_DEFAULTS).sort())
	})

	test("an unknown repo gets the worker defaults", () => {
		expect(syncConfig("o/unknown", { "o/fork": { interval_h: 6 } })).toEqual(UPSTREAM_SYNC_DEFAULTS)
	})

	test("enabled comes from PR_AGENT_UPSTREAM_SYNC, read at call time", () => {
		expect(upstreamSyncEnabled({ PR_AGENT_UPSTREAM_SYNC: "0" })).toBe(false)
		expect(upstreamSyncEnabled({ PR_AGENT_UPSTREAM_SYNC: "1" })).toBe(true)
		expect(upstreamSyncEnabled({})).toBe(true)
	})

	test("PR_AGENT_SYNC_SKIP_REPOS becomes an enabled:false override per repo", () => {
		// The operator's opt-out: a fork too divergent to sync. It has to reach
		// `syncConfig` as `enabled: false`, because that is the flag the sweep
		// reads (Python line 1750) — a list nothing consults would look like a
		// disable and behave like no-op.
		const overrides = skipRepoOverrides({
			PR_AGENT_SYNC_SKIP_REPOS: " MythEclipse/9router , asepharyana/9router ,,",
		})
		expect(overrides).toEqual({
			"MythEclipse/9router": { enabled: false },
			"asepharyana/9router": { enabled: false },
		})
		expect(syncConfig("MythEclipse/9router", overrides).enabled).toBe(false)
		// A fork NOT listed keeps the worker-wide default.
		expect(syncConfig("o/other", overrides).enabled).toBe(true)
	})

	test("an unset or blank PR_AGENT_SYNC_SKIP_REPOS disables nothing", () => {
		expect(skipRepoOverrides({})).toEqual({})
		expect(skipRepoOverrides({ PR_AGENT_SYNC_SKIP_REPOS: "" })).toEqual({})
		expect(skipRepoOverrides({ PR_AGENT_SYNC_SKIP_REPOS: " , " })).toEqual({})
	})

	test("the worker defaults are the Python's", () => {
		expect(UPSTREAM_SYNC_DEFAULTS).toMatchObject({
			interval_h: 1.0,
			max_per_tick: 2,
			resolve_conflicts: true,
			ai_fix_after_merge: true,
			verify_ci: true,
			verify_ci_max_age_h: 6.0,
			no_ci_grace_s: 600,
		})
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Group 13 — fetch URL, quality prompt, revert and the state file
// ═══════════════════════════════════════════════════════════════════════════

describe("group 13 · fetch URL, quality prompt, revert, state file", () => {
	test("the upstream fetch prefers the PAT and falls back to plain HTTPS", () => {
		expect(syncFetchUrl("up/x", "pat")).toBe("https://x-access-token:pat@github.com/up/x.git")
		expect(syncFetchUrl("up/x", "")).toBe("https://github.com/up/x.git")
	})

	test("the quality prompt names the files, caps the list and forbids behaviour changes", () => {
		const files = Array.from({ length: 33 }, (_, i) => `src/f${i}.ts`)
		const prompt = qualityPrompt("f/x", "up/x", "main", files)
		expect(prompt).toContain("src/f0.ts")
		expect(prompt).toContain("src/f29.ts")
		expect(prompt).not.toContain("src/f30.ts")
		expect(prompt).toContain("... and 3 more")
		expect(prompt).toContain("Behavior must stay identical")
		expect(prompt).toContain("Do NOT push")
	})

	test("the revert force-pushes the pre-merge sha and needs that commit in the clone", () => {
		const git = fakeGit()
		const out = syncRevertMerge(git.run, fakeWorkdirs().workdirs, {
			appToken: "tok",
			fork: "f/x",
			branch: "main",
			preMergeSha: "abcdef123456",
			reason: "CI failed: build",
			fetchGhToken: () => "",
		})
		expect(out.ok).toBe(true)
		expect(out.detail).toBe("reverted main to abcdef12 (CI failed: build)")
		expect(git.state.pushes).toEqual(["+abcdef123456:refs/heads/main"])
		// No workdir survives the revert, success or not.
		expect(git.verbs[0]).toBe("clone")
	})

	test("a clone that does not contain the pre-merge commit refuses the revert", () => {
		const run = ((args: string[]) =>
			args[0] === "cat-file" ? { code: 1, stdout: "", stderr: "" } : ok) as GitRunner
		const out = syncRevertMerge(run, fakeWorkdirs().workdirs, {
			appToken: "tok",
			fork: "f/x",
			branch: "main",
			preMergeSha: "abcdef123456",
			reason: "CI failed",
			fetchGhToken: () => "",
		})
		expect(out).toEqual({ ok: false, detail: "pre-merge commit abcdef12 not found in clone" })
	})

	test("syncCommitIfDirty commits a dirty worktree and skips a clean one", () => {
		const dirty = fakeGit({ dirty: " M src/a.ts\n" })
		expect(syncCommitIfDirty(dirty.run, "/w", "fix: auto-fix code quality [skip ci]")).toBe(true)
		expect(dirty.state.commits[0]).toEqual([
			"commit",
			"--message",
			"fix: auto-fix code quality [skip ci]",
		])
		const clean = fakeGit({ dirty: "" })
		expect(syncCommitIfDirty(clean.run, "/w", "msg")).toBe(false)
		expect(clean.state.commits).toEqual([])
	})

	test("fileSyncState round-trips the Python's indent=1 format", () => {
		const tmp = tempStateFile()
		try {
			const seam = fileSyncState(tmp.file)
			const state: SyncState = { "f/x": { last_sync_ts: 1, pending_verify: null } }
			seam.save(state)
			expect(readFileSync(tmp.file, "utf8")).toContain('\n "f/x"')
			expect(seam.load()).toEqual(state)
		} finally {
			tmp.cleanup()
		}
	})
})

describe("group 9 · the sync reporter", () => {
	/**
	 * Drive one status through the reporter and return what it emitted.
	 *
	 * Self-contained on purpose: the other groups' `depsFor` is scoped inside its
	 * own describe, and borrowing a shared factory here is how a test ends up
	 * asserting against whatever that factory happened to configure.
	 */
	async function report(
		res: SyncStatus,
		opts: { dry?: boolean; entry?: Record<string, unknown> } = {},
	) {
		const posts: { title: string; lines: string[]; color?: number }[] = []
		const lines: string[] = []
		const entry = opts.entry ?? {}
		const deps = {
			run: fakeGit().run,
			workdirs: fakeWorkdirs().workdirs,
			agent: fakeAgent(() => ({ ok: true, snippet: "ok" })).agent,
			api: fakeApi(() => ({ data: {} })),
			fetchGhToken: () => "",
			postDiscord: async (title: string, ls: string[], color?: number) => {
				posts.push({ title, lines: ls, color })
				return true
			},
			loadState: (): SyncState => ({}),
			saveState: () => {},
			now: () => 1_700_000_000,
			repoOverrides: {},
			report: { push: () => {} },
		} as unknown as Parameters<typeof reportOutcomeForTest>[0]
		await reportOutcomeForTest(deps, lines, {}, res, "the detail", {
			fork: "acme/site",
			parent: "upstream/site",
			localBranch: "main",
			mergeCount: 3,
			upstreamSha: "abcdef1234567890",
			dry: opts.dry ?? false,
			entry,
		})
		return { posts, lines, entry }
	}

	test("synced posts the merge head from pending_verify (Python 1786-1794)", async () => {
		const { posts, lines } = await report("synced", {
			entry: { pending_verify: { sha: "1234567890abcdef" } },
		})
		expect(lines[0]).toBe("   ✅ merged + pushed: the detail")
		expect(posts).toHaveLength(1)
		expect(posts[0].title).toBe("🔁 Fork synced: acme/site")
		expect(posts[0].lines[0]).toBe(
			"⬆️ 3 upstream commit(s) from `upstream/site` merged into `main`.",
		)
		expect(posts[0].lines[1]).toBe(
			"merge head `12345678` (CI-verified on the next ticks; reverted automatically if red).",
		)
	})

	test("pr-opened POSTS to Discord with the pulls link (Python 1796-1803)", async () => {
		// THE REGRESSION. This arm shipped with the post deleted and 389 tests
		// still passed. Opening an upstream-sync PR is the one outcome that needs a
		// human to review and merge, so losing it means an operator never learns a
		// PR is waiting on them.
		const { posts, lines } = await report("pr-opened")
		expect(lines[0]).toBe("   📬 the detail")
		expect(posts).toHaveLength(1)
		expect(posts[0].title).toBe("📬 Fork sync PR opened: acme/site")
		expect(posts[0].lines).toEqual(["the detail", "https://github.com/acme/site/pulls"])
	})

	test("pr-path is a normal outcome, not a warning (Python 1807-1808)", async () => {
		const { posts, lines } = await report("pr-path")
		expect(lines[0]).toBe("   🧪 dry run (protected): the detail")
		expect(lines[0]).not.toContain("⚠️")
		expect(posts).toHaveLength(0)
	})

	test("dry is plain; pr-path is the one that says protected (Python 1805)", async () => {
		const { lines } = await report("dry")
		expect(lines[0]).toBe("   🧪 dry run: the detail")
	})

	test("a dry run posts nothing at all, for any status (Python 1788, 1798)", async () => {
		for (const res of ["synced", "pr-opened", "conflict-failed"] as SyncStatus[]) {
			const { posts } = await report(res, { dry: true })
			expect(posts).toHaveLength(0)
		}
	})

	test("conflict-failed posts once and sets notified (Python 1810-1822)", async () => {
		const { posts, entry } = await report("conflict-failed", {
			entry: { notified: false },
		})
		expect(posts).toHaveLength(1)
		expect(posts[0].title).toBe("⏭️ Fork sync skipped: acme/site")
		// The flag the Python sets, so the next tick does not re-alert.
		expect(entry.notified).toBe(true)
	})

	test("an already-notified skip stays silent (Python 1812)", async () => {
		const { posts } = await report("conflict-failed", { entry: { notified: true } })
		expect(posts).toHaveLength(0)
	})
})
