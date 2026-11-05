// biome-ignore-all lint/suspicious/noExplicitAny: test fakes stand in for untyped GitHub payloads
import { createHmac } from "node:crypto"
import { describe, expect, test } from "vitest"
import { checkCiPassed, closeStaleCiPr } from "../src/pr/ci.ts"
import { closeToolchainPr, toolchainPinViolation } from "../src/pr/pins.ts"
import { findReviewComment, findTrivialNoReviewMarker, triggerReview } from "../src/pr/review.ts"
import { analyzeReviewSafety } from "../src/pr/safety.ts"
import type { GhAppClient, GhClient } from "../src/pr/scan.ts"
import { gatherOpenPrs } from "../src/pr/scan.ts"

describe("safety", () => {
	const clean =
		"🔒 No security concerns identified\n⚡ No major issues detected\n🧪 No relevant tests\n⏱️ Estimated effort to review [1-5]: 1 🔵⚪⚪⚪⚪"
	test("clean review passes with score >= 6", () => {
		const r = analyzeReviewSafety(clean)
		expect(r.safe).toBe(true)
		expect(r.score).toBeGreaterThanOrEqual(6)
	})
	test("an error body blocks", () => {
		expect(analyzeReviewSafety("Failed to generate").safe).toBe(false)
		expect(analyzeReviewSafety("RetryError").safe).toBe(false)
		expect(analyzeReviewSafety("traceback").safe).toBe(false)
	})
	test("a security concern blocks", () => {
		expect(analyzeReviewSafety("🔒 Security concerns: SQL injection risk").safe).toBe(false)
	})
	test("a major issue blocks", () => {
		expect(analyzeReviewSafety("⚡ Breaking change detected").safe).toBe(false)
	})
	test("empty body blocks", () => {
		expect(analyzeReviewSafety("").safe).toBe(false)
	})
})

describe("toolchain pins", () => {
	test("flags a disallowed major on a pinned package", () => {
		expect(
			toolchainPinViolation(
				"asepharyana/nextjs-template",
				"chore(deps): bump typescript from 5.9.0 to 7.0.0",
			),
		).toEqual(["typescript", "5.9.0", "7.0.0"])
	})
	test("allows the pinned major", () => {
		expect(
			toolchainPinViolation(
				"asepharyana/nextjs-template",
				"chore(deps-dev): bump typescript from 6.0.0 to 6.1.0",
			),
		).toBeNull()
	})
	test("ignores repos without pins", () => {
		expect(
			toolchainPinViolation("o/r", "chore(deps): bump typescript from 5.0.0 to 7.0.0"),
		).toBeNull()
	})
})

describe("ci gate", () => {
	const api = (data: unknown) => ({ request: async () => ({ status: 200, data }) }) as any
	test("no checks configured passes", async () => {
		expect(await checkCiPassed(api({ check_runs: [] }), "t", "o/r", "sha")).toEqual({
			ok: true,
			msg: "✅ No CI configured — skipping CI gate",
		})
	})
	test("failure blocks", async () => {
		const r = await checkCiPassed(
			api({ check_runs: [{ name: "ci", conclusion: "failure", status: "completed" }] }),
			"t",
			"o/r",
			"sha",
		)
		expect(r.ok).toBe(false)
		expect(r.msg).toContain("ci")
	})
	test("pending blocks", async () => {
		const r = await checkCiPassed(
			api({ check_runs: [{ name: "ci", conclusion: null, status: "in_progress" }] }),
			"t",
			"o/r",
			"sha",
		)
		expect(r.ok).toBe(false)
	})
	test("all green passes", async () => {
		expect(
			(
				await checkCiPassed(
					api({ check_runs: [{ name: "ci", conclusion: "success", status: "completed" }] }),
					"t",
					"o/r",
					"sha",
				)
			).ok,
		).toBe(true)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Everything below is this task's own coverage of the behaviour the brief's
// table does not reach: the comment finders, the close-PR request sequences,
// the scan fan-out, and triggerReview's wire contract.
// ═══════════════════════════════════════════════════════════════════════════

/** Records every call so a test can assert the exact request sequence. */
type Call = { method: string; path: string; token?: string; json?: unknown }

function recorder(
	handler: (call: Call, n: number) => { status: number; data: unknown } = () => ({
		status: 200,
		data: {},
	}),
): { api: GhClient; calls: Call[] } {
	const calls: Call[] = []
	const api: GhClient = {
		async request(method, path, opts) {
			const call = { method, path, token: opts?.token, json: opts?.json }
			calls.push(call)
			return handler(call, calls.length) as any
		},
	}
	return { api, calls }
}

describe("safety — detail beyond the brief table", () => {
	test("an empty body reports the Python's own reason strings", () => {
		// Python line 354: `return False, ["❌ No review"], 0`.
		expect(analyzeReviewSafety("")).toEqual({ safe: false, reasons: ["❌ No review"], score: 0 })
	})
	test("an error body names the pattern that tripped it", () => {
		// Python line 359: the reason embeds the matched pattern verbatim.
		expect(analyzeReviewSafety("all good\nInternal Server Error happened")).toEqual({
			safe: false,
			reasons: ["❌ Review error: Internal Server Error"],
			score: 0,
		})
	})
	test("a security row with content that is neither clear nor empty is a concern", async () => {
		// The load-bearing new case. A `🔒` row whose value is real prose must
		// BLOCK, including when the prose sits below the heading across the
		// renderer's `<br><br>` line break — that break is INSIDE a row, so
		// treating a newline as a row boundary truncated the row to its heading,
		// read the empty remainder as "clean", and waved a real SQL injection
		// through. The row ends at `</td>` or the next emoji heading, never at a
		// line break.
		const gfm = analyzeReviewSafety(
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\n**src/auth.ts** — SQL injection risk\n</td></tr>\n</table>",
		)
		expect(gfm.safe).toBe(false)
		expect(gfm.reasons).toContain("🔴 Security concern — blocking")

		// Same content, plain (non-GFM) format.
		const plain = analyzeReviewSafety(
			"### 🔒 Security concerns\n\nSQL injection in src/auth.ts\n### ⚡ No major issues detected",
		)
		expect(plain.safe).toBe(false)
	})

	test("the GMW#109 body — a negation under a bare heading — reads as clean", async () => {
		// The body that produced the 0/10 block, byte for byte from the PR. The
		// model's YAML said the security verdict was `No`, but a leaked code
		// fence rode along in the value, so the renderer's `isValueNo` missed it
		// and emitted the bare "Security concerns" heading followed by a
		// negation. A phrase-matching gate read that shape as a concern and
		// blocked a PR whose security verdict was, in plain English, "No".
		const body =
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nNo\n```\n</td></tr>\n</table>"
		const r = analyzeReviewSafety(body)
		expect(r.reasons).toContain("✅ Security: clean")
		expect(r.safe).toBe(true)
	})

	test("an EMPTY 'Key issues to review' row is clean, not unclear", () => {
		// The live hub#53/#54/#52 body, transcribed from the PR comment. The
		// renderer's `key issues` arm emits `No key issues identified` as filler
		// when the model's list is empty (`markdown.ts`: `parts.join("\n\n") ||
		// "No key issues identified"`), and the ⚡ row is `Key issues to review`,
		// NOT `No major issues detected`.
		//
		// `ISSUES_CLEAR` matches only the latter phrase, so every dependabot bump
		// whose reviewer found nothing scored `⚠️ Issues unclear` — the exact line
		// in the hub#53 ops report — which docks a point and, more importantly,
		// tells an operator the review was unclear when it said the opposite.
		// Measured across the fleet on 2026-10-19: 62 of the 109 PRs carrying a
		// ⚡ findings row have this empty shape.
		const live =
			"<tr><td>⚡&nbsp;<strong>Key issues to review</strong><br><br>\n\n" +
			"No key issues identified\n</td></tr>\n" +
			"<tr><td>🔒&nbsp;<strong>No security concerns identified</strong></td></tr>"
		const r = analyzeReviewSafety(live)
		expect(r.reasons).not.toContain("⚠️ Issues unclear")
		expect(r.reasons).toContain("✅ No major issues")
	})

	test("a 'Key issues to review' row carrying REAL items does not buy the clear score", () => {
		// The other direction, and the reason this cannot be a blank-row test
		// alone: the SAME heading carries the model's findings when it has any.
		// Live from GMW#114. A row with items must NOT be read as empty — if
		// `readIssuesRow` stripped them to a blank it would score +2, so the
		// assertion is the SCORE, not just the absence of a phrase.
		//
		// The security row is present and clean so the arithmetic isolates the ⚡
		// row: with items the review is `unclear` (5 +2 −1 +1 = 7), and if the
		// items were misread as an empty row it would be 9.
		const items =
			"<tr><td>⚡&nbsp;<strong>Key issues to review</strong><br><br>\n\n" +
			"**package.json\n** — \n</td></tr>\n" +
			"<tr><td>🔒&nbsp;<strong>No security concerns identified</strong></td></tr>"
		const r = analyzeReviewSafety(items)
		expect(r.reasons).toContain("⚠️ Issues unclear")
		expect(r.reasons).not.toContain("✅ No major issues")
		expect(r.score).toBe(7)
	})

	test("an empty 'Recommended focus areas' row is clean too", () => {
		// The renderer's other ⚡ heading (hub#34). Same meaning, different label,
		// and the second live shape the old phrase-gate could not read.
		const empty =
			"<tr><td>⚡&nbsp;<strong>Recommended focus areas for review</strong><br><br>\n\n</td></tr>"
		expect(analyzeReviewSafety(empty).reasons).toContain("✅ No major issues")
	})

	test("the other two renderings of a clean verdict also pass", async () => {
		// Same verdict, three renderer output shapes. All must clear — this is
		// the axis the old phrase-gate could not cover.
		for (const body of [
			"🔒&nbsp;<strong>No security concerns identified</strong></td></tr>",
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nNo security concerns identified\n</td>",
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nNone detected\n</td>",
			"### 🔒 No security concerns identified",
		]) {
			const r = analyzeReviewSafety(body)
			expect(r.reasons, body).toContain("✅ Security: clean")
		}
	})

	test("a row describing the update's OWN security fixes is not a finding here", () => {
		// THE LIVE BODY from mcpedia#48, byte for byte — trimmed only of the
		// dependency table above it. The `🔒` row answers a question about the
		// BUMP, not about this repository: the reviewer was asked whether the
		// update touches security, and said "yes, it fixes things". Read as a
		// concern, that blocked a security update because it was a security
		// update — 0/10, every five minutes, forever.
		const live = [
			"## PR Reviewer Guide 🔍",
			"",
			"<table>",
			"<tr><td>⏱️&nbsp;<strong>Estimated effort to review</strong>: 1 🔵⚪⚪⚪⚪</td></tr>",
			"<tr><td>🧪&nbsp;<strong>No relevant tests</strong></td></tr>",
			"<tr><td>⚡&nbsp;<strong>Key issues to review</strong><br><br>",
			"",
			"No key issues identified",
			"</td></tr>",
			"<tr><td>🔒&nbsp;<strong>Security concerns</strong><br><br>",
			"",
			"Yes. Hono security fixes.</td></tr>",
			"</table>",
		].join("\n")
		const r = analyzeReviewSafety(live)
		expect(r.reasons).toContain(
			"ℹ️ Security row describes the update's security fixes, not a finding here",
		)
		expect(r.safe).toBe(true)
		// NOT the clean bonus: the reviewer was answering a different question,
		// so this must not score what a verified-clean row scores.
		expect(r.reasons).not.toContain("✅ Security: clean")
	})

	test("a remediation reading still blocks when the row names a weakness", () => {
		// The asymmetry that makes widening safe. These rows mention a fix AND a
		// weakness; a false clear merges a vulnerability, so every one of them
		// must stay a hard block.
		for (const body of [
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nThe bump patches the middleware bypass\n</td>",
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nFixes CVE-2026-1234 but hardcoded secret in config.ts\n</td>",
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nSecurity fixes applied; SQL injection remains in src/auth.ts\n</td>",
		]) {
			const r = analyzeReviewSafety(body)
			expect(r.safe, body).toBe(false)
			expect(r.reasons, body).toContain("🔴 Security concern — blocking")
		}
	})

	test("an OBLIGATION phrased as a fix is still a finding, not a remediation", () => {
		// The false clear this guard was widened for, caught by probing the real
		// gate rather than by reading it. "needs a security fix" and "the update
		// fixes security" are one word apart and mean opposite things about this
		// PR; without `OBLIGATION` the first was promoted to `remediated` and the
		// PR could merge on a finding against its own code.
		for (const body of [
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nYes, this needs a security fix before merging</td>",
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nThe auth helper should be patched for security</td>",
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nSecurity fix required in src/session.ts</td>",
		]) {
			const r = analyzeReviewSafety(body)
			expect(r.safe, body).toBe(false)
			expect(r.reasons, body).toContain("🔴 Security concern — blocking")
		}
	})

	test("a real finding with no remediation language is untouched by the new reading", () => {
		// The pre-existing contract, re-pinned because the row reader changed:
		// these are the shapes the gate was rebuilt to catch.
		for (const body of [
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\n**src/auth.ts** — SQL injection risk\n</td></tr>",
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nYes - TLS certificate trust issue\n</td></tr>",
			"### 🔒 Security concerns\n\nSQL injection in src/auth.ts\n### ⚡ No major issues detected",
		]) {
			expect(analyzeReviewSafety(body).safe, body).toBe(false)
		}
	})

	test("the long mcpedia#48 body is NOT promoted — it describes three CVEs", () => {
		// The same PR posted two reviews. The second enumerates a path bypass, a
		// wildcard-middleware skip and a CSRF bypass, so it names risk language
		// and stays blocked. That is the intended outcome: this one is retired by
		// the safety-block ceiling instead of looping, not waved through.
		const long =
			"🔒&nbsp;<strong>Security concerns</strong><br><br>\n\n" +
			"**Hono security fixes**: includes several security fixes:\n\n" +
			"1. **Path bypass vulnerability**: crafted requests could bypass middleware.\n" +
			"</td></tr>"
		const r = analyzeReviewSafety(long)
		expect(r.safe).toBe(false)
		expect(r.reasons).toContain("🔴 Security concern — blocking")
	})

	test("a missing security row is neither a pass nor a penalty", async () => {
		// No `🔒` row at all is not evidence of anything. It used to cost a
		// point as "Security unclear", which docked a review merely for using a
		// format without that row.
		const r = analyzeReviewSafety("⚡ No major issues detected\n⏱️ effort: 2")
		expect(r.reasons).toEqual(["⚠️ No security row in the review", "✅ No major issues"])
		expect(r.score).toBe(8) // 5 +0 +2 +1
		expect(r.safe).toBe(true)
	})

	test("an unclear ISSUES section still costs a point rather than blocking", async () => {
		// The `⚡` row keeps its original phrase-matching semantics. Only the
		// security row was rebuilt, because only it had a renderer shape that
		// inverted the verdict.
		const r = analyzeReviewSafety("🔒 No security concerns identified\n⚡ unclear\n⏱️ effort: 2")
		expect(r.reasons).toEqual(["✅ Security: clean", "⚠️ Issues unclear"])
		expect(r.score).toBe(7) // 5 +2 -1 +1
		expect(r.safe).toBe(true)
	})
	test("effort >= 4 on the same line costs a point", () => {
		// The effort regex is LAZY (`.*?(\d+)`) and `.` does not cross a newline, so
		// it reads the FIRST digit on the ⏱️ line only.
		const r = analyzeReviewSafety(
			"🔒 No security concerns identified\n⚡ No major issues detected\n⏱️ 4 of 5 files to review",
		)
		expect(r.reasons).toContain("⚠️ Large PR (effort: 4)")
		expect(r.score).toBe(8) // 5 +2 +2 -1
	})
	test("a later line's digit does not leak into the effort score", () => {
		// Line-scoping proof: a 9 on the following line must be invisible to the
		// ⏱️ pattern. With the dot unescaped and non-newline-matching, effort = 1.
		const r = analyzeReviewSafety(
			"🔒 No security concerns identified\n⚡ No major issues detected\n⏱️ Estimated effort to review: 1\n9 files changed",
		)
		expect(r.reasons.some((x) => x.startsWith("⚠️ Large PR"))).toBe(false)
		expect(r.score).toBe(10)
	})
	test("tests missing costs a point but does not block", () => {
		const r = analyzeReviewSafety(
			"🔒 No security concerns identified\n⚡ No major issues detected\n🧪 tests missing for the new branch\n⏱️ effort: 1",
		)
		expect(r.reasons).toContain("⚠️ Tests missing")
		expect(r.safe).toBe(true)
	})
	test("unclear sections and no security row can still push a review below threshold", () => {
		// The security row no longer has an "unclear" state — it is clear, a
		// concern (an early return at 0), or absent (no penalty). The remaining
		// deductions are the `⚡` row, the tests row and the effort rating, and
		// together they still reach a blocking score:
		//   5 +0 (no security row) −1 (issues) −1 (tests) −1 (effort 5) = 2.
		const r = analyzeReviewSafety("⚡ ?\n🧪 Test required\n⏱️ effort: 5")
		expect(r.safe).toBe(false)
		expect(r.score).toBe(2)
	})
	test("the reachable score range is 2..10 once the security row is rebuilt", () => {
		// WHAT THIS PINS, precisely. `Math.max(0, Math.min(10, score))` is a
		// byte-for-byte port of Python line 390 and stays in safety.ts. This test
		// does NOT claim to exercise the floor — it proves the floor is
		// unreachable, and pins the real bounds:
		//   * every body that REACHES the clamp scores in 2..10, so `max(0, ·)` is
		//     dead defensive code against the current scoring and
		//   * 10 is the maximum, reached at the all-clear body, so `min(10, ·)`
		//     passes that value through unchanged.
		// The security row is ENUMERATED, unlike before, because its verdict is
		// now read from the row's content and so has exactly three states: clean
		// (+2), a blocking concern (an EARLY RETURN at 0, never reaching the
		// clamp), and absent (0, no penalty). The early-return states are
		// excluded from the enumeration below for that reason.
		const SEC = {
			clear: "🔒 No security concerns identified",
			degenerate: "🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nNo\n```\n</td>",
			absent: null,
		}
		const ISS = { clear: "⚡ No major issues detected", unclear: "⚡ ?" }
		const TST = { absent: null, missing: "🧪 tests missing", irrelevant: "🧪 No relevant tests" }
		const EFF = { absent: null, small: "⏱️ effort: 1", large: "⏱️ effort: 4" }

		const reached: number[] = []
		for (const s of Object.values(SEC))
			for (const i of Object.values(ISS))
				for (const t of Object.values(TST))
					for (const e of Object.values(EFF)) {
						const body = [s, i, t, e].filter(Boolean).join("\n")
						reached.push(analyzeReviewSafety(body).score)
					}
		expect([...new Set(reached)].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])

		// The floor: 5 +0 (no security row) −1 (issues) −1 (tests) −1 (effort).
		// The rating is 5 vs 9, and it makes NO difference, which is the fact the
		// old "second missing-tests hit" comment invented a mechanism for and
		// never had.
		expect(analyzeReviewSafety("⚡ ?\n🧪 Test required\n⏱️ effort: 5").score).toBe(2)
		expect(analyzeReviewSafety("⚡ ?\n🧪 Test required\n⏱️ effort: 9").score).toBe(2)

		// BOTH clean renderings of the security verdict score identically — the
		// degenerate one is the GMW#109 shape and used to score 0 (a hard block).
		// 5 +2 (security clean) −1 (issues `⚡ ?`) +1 (effort 1) = 7.
		expect(analyzeReviewSafety(SEC.clear + "\n⚡ ?\n⏱️ effort: 1").score).toBe(7)
		expect(analyzeReviewSafety(SEC.degenerate + "\n⚡ ?\n⏱️ effort: 1").score).toBe(7)

		// The ceiling: 5 +2 (security clean) +2 (issues clear) +1 (small effort).
		expect(
			analyzeReviewSafety(
				"🔒 No security concerns identified\n⚡ No major issues detected\n⏱️ effort: 1",
			).score,
		).toBe(10)
	})
})

describe("toolchain pins — the full map", () => {
	const REPO = "asepharyana/nextjs-template"
	test("every pinned package is enforced", () => {
		// Python lines 510-520, transcribed package for package.
		for (const [pkg, major] of [
			["typescript", 6],
			["eslint", 9],
			["eslint-config-next", 16],
			["eslint-plugin-react", 7],
			["@tsparticles/react", 3],
			["@tsparticles/engine", 3],
			["@tsparticles/slim", 3],
		] as const) {
			expect(
				toolchainPinViolation(REPO, `chore(deps): bump ${pkg} from 1.0.0 to ${major + 1}.0.0`),
			).toEqual([pkg, "1.0.0", `${major + 1}.0.0`])
			expect(
				toolchainPinViolation(REPO, `chore(deps): bump ${pkg} from 1.0.0 to ${major}.4.2`),
			).toBeNull()
		}
	})
	test("a non-pinned package in a pinned repo is ignored", () => {
		expect(toolchainPinViolation(REPO, "chore(deps): bump left-pad from 1.0.0 to 9.0.0")).toBeNull()
	})
	test("the title must match the whole dependabot shape", () => {
		expect(toolchainPinViolation(REPO, "Bump typescript from 5.9.0 to 7.0.0")).toBeNull()
		expect(toolchainPinViolation(REPO, "chore: bump typescript from 5.9.0 to 7.0.0")).toBeNull()
		expect(toolchainPinViolation(REPO, "chore(deps): bump typescript to 7.0.0")).toBeNull()
	})
	test("a malformed version fails open instead of throwing", () => {
		// DELIBERATE DIVERGENCE from Python line 538, which does
		// `int(new_ver.split(".")[0])` and raises ValueError on a version whose
		// first segment is empty — a raised exception would abort the whole tick.
		// Probed against the real function: "to .9" raises in Python.
		expect(toolchainPinViolation(REPO, "chore(deps): bump typescript from 1.0.0 to .9")).toBeNull()
		expect(toolchainPinViolation(REPO, "chore(deps): bump typescript from 1.0.0 to ..7")).toBeNull()
	})
	test("a trailing-dot version still flags like Python", () => {
		// `int("7")` is 7 in both languages: not a divergence, a real violation.
		expect(toolchainPinViolation(REPO, "chore(deps): bump typescript from 1.0.0 to 7.")).toEqual([
			"typescript",
			"1.0.0",
			"7.",
		])
	})
})

describe("ci gate — messages and guard", () => {
	test("names up to three failures are joined", async () => {
		const r = await checkCiPassed(
			{
				request: async () => ({
					status: 200,
					data: {
						check_runs: [
							{ name: "typecheck", conclusion: "failure", status: "completed" },
							{ name: "build", conclusion: "failure", status: "completed" },
							{ name: "lint", conclusion: "failure", status: "completed" },
							{ name: "fourth", conclusion: "failure", status: "completed" },
						],
					},
				}),
			},
			"t",
			"o/r",
			"sha",
		)
		// Python line 403: `failed[:3]` then ", ".join.
		expect(r).toEqual({ ok: false, msg: "CI FAILED: typecheck, build, lint" })
	})
	test("pending names up to three are joined", async () => {
		const r = await checkCiPassed(
			{
				request: async () => ({
					status: 200,
					data: { check_runs: [{ name: "typecheck", status: "queued" }] },
				}),
			},
			"t",
			"o/r",
			"sha",
		)
		expect(r).toEqual({ ok: false, msg: "CI pending: typecheck" })
	})
	test("a failure outranks a pending run", async () => {
		const r = await checkCiPassed(
			{
				request: async () => ({
					status: 200,
					data: {
						check_runs: [
							{ name: "late", status: "in_progress" },
							{ name: "boom", conclusion: "failure", status: "completed" },
						],
					},
				}),
			},
			"t",
			"o/r",
			"sha",
		)
		expect(r.msg).toBe("CI FAILED: boom")
	})
	test("all green reports the count", async () => {
		const r = await checkCiPassed(
			{
				request: async () => ({
					status: 200,
					data: {
						check_runs: [
							{ name: "a", conclusion: "success", status: "completed" },
							{ name: "b", conclusion: "neutral", status: "completed" },
						],
					},
				}),
			},
			"t",
			"o/r",
			"sha",
		)
		expect(r).toEqual({ ok: true, msg: "✅ 2 checks green" })
	})
	test("a cancelled or timed-out run is RED, not green", async () => {
		// The gate used to test `conclusion === "failure"` alone and treat every
		// other `completed` verdict as a pass, so a run that never executed the
		// suite merged the PR. Probed before the fix: all five of these returned
		// `✅ 1 checks green`.
		for (const conclusion of [
			"cancelled",
			"timed_out",
			"startup_failure",
			"action_required",
			"stale",
		]) {
			const r = await checkCiPassed(
				{
					request: async () => ({
						status: 200,
						data: { check_runs: [{ name: "ci", conclusion, status: "completed" }] },
					}),
				},
				"t",
				"o/r",
				"sha",
			)
			expect(r.ok).toBe(false)
			expect(r.msg).toBe("CI FAILED: ci")
		}
	})
	test("a non-blocking verdict stays green", async () => {
		// `neutral` and `skipped` are GitHub's non-blocking conclusions and a
		// required-check rule passes them too. Treating them as red would block
		// every PR in a repo that path-filters a job.
		for (const conclusion of ["success", "neutral", "skipped"]) {
			const r = await checkCiPassed(
				{
					request: async () => ({
						status: 200,
						data: { check_runs: [{ name: "a", conclusion, status: "completed" }] },
					}),
				},
				"t",
				"o/r",
				"sha",
			)
			expect(r.ok).toBe(true)
		}
	})
	test("a transport failure is reported as unknown, never as 'no CI'", async () => {
		const r = await checkCiPassed(
			{ request: async () => ({ status: 0, data: {} }) },
			"t",
			"o/r",
			"sha",
		)
		expect(r).toEqual({ ok: false, unknown: true, msg: "⚠️ CI status unavailable (HTTP 0)" })
	})
	test("a 500 with an unparseable body is reported as unknown", async () => {
		const r = await checkCiPassed(
			{ request: async () => ({ status: 500, data: {} }) },
			"t",
			"o/r",
			"sha",
		)
		expect(r).toEqual({ ok: false, unknown: true, msg: "⚠️ CI status unavailable (HTTP 500)" })
	})
	test("an error envelope never reaches the 'no CI configured' pass", async () => {
		const r = await checkCiPassed(
			{ request: async () => ({ status: 403, data: { message: "Bad credentials" } }) },
			"t",
			"o/r",
			"sha",
		)
		expect(r.ok).toBe(false)
		expect(r.unknown).toBe(true)
	})
	test("a non-object body is treated as no CI", async () => {
		const r = await checkCiPassed(
			{ request: async () => ({ status: 200, data: null }) },
			"t",
			"o/r",
			"sha",
		)
		expect(r.ok).toBe(true)
	})
	test("the check-runs path and the installation token are used", async () => {
		const { api, calls } = recorder()
		await checkCiPassed(api, "tok", "o/r", "abc123")
		expect(calls).toEqual([
			{
				method: "GET",
				path: "/repos/o/r/commits/abc123/check-runs",
				token: "tok",
				json: undefined,
			},
		])
	})
})

describe("closeStaleCiPr", () => {
	test("comments first, then PATCHes the PR closed", async () => {
		const { api, calls } = recorder()
		const r = await closeStaleCiPr(api, "tok", "o/r", 7, "some title", "CI FAILED: typecheck")
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /repos/o/r/issues/7/comments",
			"PATCH /repos/o/r/pulls/7",
		])
		expect(calls[0].json).toEqual({ body: expect.stringContaining("**stale failing CI**") })
		expect(calls[0].json).toEqual({
			body: expect.stringContaining("CI has been failing for 2+ days"),
		})
		expect(calls[0].json).toEqual({ body: expect.stringContaining("`CI FAILED: typecheck`") })
		expect(calls[1].json).toEqual({ state: "closed" })
		expect(calls.every((c) => c.token === "tok")).toBe(true)
		expect(r).toEqual({ status: 200, commentStatus: 200 })
	})
	test("a failed comment does not stop the close", async () => {
		const { api, calls } = recorder((c) =>
			c.method === "POST" ? { status: 422, data: { message: "nope" } } : { status: 200, data: {} },
		)
		const r = await closeStaleCiPr(api, "tok", "o/r", 7, "t", "CI pending: ci")
		expect(calls).toHaveLength(2)
		expect(r).toEqual({ status: 200, commentStatus: 422 })
	})
	test("a failed close reports the close status", async () => {
		const { api } = recorder((c) =>
			c.method === "POST" ? { status: 201, data: {} } : { status: 403, data: {} },
		)
		expect(await closeStaleCiPr(api, "tok", "o/r", 7, "t", "m")).toEqual({
			status: 403,
			commentStatus: 201,
		})
	})
})

describe("closeToolchainPr", () => {
	test("comments first, then PATCHes the PR closed", async () => {
		const { api, calls } = recorder()
		const r = await closeToolchainPr(api, "tok", "o/r", 12, "typescript", "5.9.0", "7.0.0")
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /repos/o/r/issues/12/comments",
			"PATCH /repos/o/r/pulls/12",
		])
		expect(calls[0].json).toEqual({ body: expect.stringContaining("**toolchain pin violation**") })
		expect(calls[0].json).toEqual({ body: expect.stringContaining("`typescript` 5.9.0 → 7.0.0") })
		expect(calls[0].json).toEqual({ body: expect.stringContaining("it will **not** be merged") })
		expect(calls[1].json).toEqual({ state: "closed" })
		expect(calls.every((c) => c.token === "tok")).toBe(true)
		expect(r).toEqual({ status: 200, commentStatus: 200 })
	})
	test("a failed comment does not stop the close", async () => {
		const { api, calls } = recorder((c) =>
			c.method === "POST" ? { status: 500, data: {} } : { status: 200, data: {} },
		)
		const r = await closeToolchainPr(api, "tok", "o/r", 12, "eslint", "9.0.0", "10.0.0")
		expect(calls).toHaveLength(2)
		expect(r).toEqual({ status: 200, commentStatus: 500 })
	})
})

describe("findReviewComment", () => {
	const guide = "## PR Reviewer Guide 🔍\n🔒 No security concerns identified"
	test("returns the bot comment body containing the guide", async () => {
		const { api, calls } = recorder(() => ({
			status: 200,
			data: [
				{ user: { login: "dependabot[bot]" }, body: "bump stuff" },
				{ user: { login: "mytheclipsebotreview[bot]" }, body: guide },
			],
		}))
		expect(await findReviewComment(api, "tok", "o/r", 7)).toBe(guide)
		expect(calls).toEqual([
			{ method: "GET", path: "/repos/o/r/issues/7/comments", token: "tok", json: undefined },
		])
	})
	test("matches a login CONTAINING the bot login", async () => {
		// Python line 326: `if BOT_LOGIN in login` — a substring test, not equality.
		const { api } = recorder(() => ({
			status: 200,
			data: [{ user: { login: "prefix-mytheclipsebotreview-suffix" }, body: guide }],
		}))
		expect(await findReviewComment(api, "tok", "o/r", 7)).toBe(guide)
	})
	test("a bot comment without the guide is skipped, and null is the default", async () => {
		const { api } = recorder(() => ({
			status: 200,
			data: [{ user: { login: "mytheclipsebotreview[bot]" }, body: "PR Code Suggestions" }],
		}))
		expect(await findReviewComment(api, "tok", "o/r", 7)).toBeNull()
	})
	test("another author's guide does not count", async () => {
		const { api } = recorder(() => ({
			status: 200,
			data: [{ user: { login: "somebody-else" }, body: guide }],
		}))
		expect(await findReviewComment(api, "tok", "o/r", 7)).toBeNull()
	})
	test("a non-array response is null", async () => {
		const { api } = recorder(() => ({ status: 200, data: { message: "Not Found" } }))
		expect(await findReviewComment(api, "tok", "o/r", 7)).toBeNull()
	})
	test("a comment with no user or body does not throw", async () => {
		const { api } = recorder(() => ({ status: 200, data: [{}, { user: {} }] }))
		expect(await findReviewComment(api, "tok", "o/r", 7)).toBeNull()
	})

	// THE SUPERSEDED REVIEW MUST NOT WIN.
	//
	// This is hub#61 in miniature, taken from the real comment pair: the first
	// bot comment says a security issue was found, a later run rewrote the
	// persistent comment to say none was, and an update marker sits in between.
	// Returning the first match scored the STALE body and blocked the PR at
	// 0/10 on ten consecutive ticks, each of them re-reading the same old copy.
	test("returns the LATEST review, not the superseded one", async () => {
		const stale =
			"## PR Reviewer Guide 🔍\n\n<table><tr><td>🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nYes - TLS certificate trust issue\n\n</td></tr></table>"
		const current =
			"## PR Reviewer Guide 🔍\n\n#### (Review updated until commit 3187254e)\n\n<table><tr><td>🔒&nbsp;<strong>No security concerns identified</strong></td></tr></table>"
		const marker =
			"**[Persistent review](<https://x>)** updated to latest commit [3187254e](3187254e)"
		const { api } = recorder(() => ({
			status: 200,
			data: [
				{ user: { login: "dependabot[bot]" }, body: "bump" },
				{ user: { login: "mytheclipsebotreview[bot]" }, body: stale },
				{ user: { login: "mytheclipsebotreview[bot]" }, body: marker },
				{ user: { login: "mytheclipsebotreview[bot]" }, body: current },
			],
		}))
		const got = await findReviewComment(api, "tok", "o/r", 7)
		expect(got).toBe(current)
		// The marker alone is never a review.
		expect(got).not.toBe(marker)
	})
})

describe("findTrivialNoReviewMarker", () => {
	const marker = "## PR Code Suggestions\n\nNo code suggestions found"
	test("true only when both markers are in a bot comment", async () => {
		const { api } = recorder(() => ({
			status: 200,
			data: [{ user: { login: "mytheclipsebotreview[bot]" }, body: marker }],
		}))
		expect(await findTrivialNoReviewMarker(api, "tok", "o/r", 7)).toBe(true)
	})
	test("one marker alone is not enough", async () => {
		const onlySuggestions = recorder(() => ({
			status: 200,
			data: [{ user: { login: "mytheclipsebotreview[bot]" }, body: "## PR Code Suggestions" }],
		}))
		expect(await findTrivialNoReviewMarker(onlySuggestions.api, "tok", "o/r", 7)).toBe(false)
		const onlyEmpty = recorder(() => ({
			status: 200,
			data: [{ user: { login: "mytheclipsebotreview[bot]" }, body: "No code suggestions found" }],
		}))
		expect(await findTrivialNoReviewMarker(onlyEmpty.api, "tok", "o/r", 7)).toBe(false)
	})
	test("both markers from a different author is false", async () => {
		const { api } = recorder(() => ({
			status: 200,
			data: [{ user: { login: "dependabot[bot]" }, body: marker }],
		}))
		expect(await findTrivialNoReviewMarker(api, "tok", "o/r", 7)).toBe(false)
	})
	test("a non-array response is false", async () => {
		const { api } = recorder(() => ({ status: 200, data: { message: "Not Found" } }))
		expect(await findTrivialNoReviewMarker(api, "tok", "o/r", 7)).toBe(false)
	})
})

describe("gatherOpenPrs", () => {
	/** Installs 1 and 2; the target repo lives under install 2 only. */
	function appApi(pulls: unknown): { api: GhAppClient; calls: Call[] } {
		const calls: Call[] = []
		const api: GhAppClient = {
			async request(method, path, opts) {
				calls.push({ method, path, token: opts?.token, json: opts?.json })
				if (path === "/app/installations") {
					return { status: 200, data: [{ id: 1 }, { id: 2 }] } as any
				}
				if (path === "/installation/repositories") {
					return {
						status: 200,
						data: {
							repositories:
								opts?.token === "tok-2"
									? [{ full_name: "owner/target" }]
									: [{ full_name: "owner/other" }],
						},
					} as any
				}
				return { status: 200, data: pulls } as any
			},
			async installationToken(installId: number) {
				return `tok-${installId}`
			},
		}
		return { api, calls }
	}

	test("fans out installs → repos → pulls and pairs each PR with its token", async () => {
		const { api, calls } = appApi([{ number: 5 }])
		const out = await gatherOpenPrs(api)
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /app/installations",
			"GET /installation/repositories",
			"GET /repos/owner/other/pulls?state=open&per_page=20&sort=updated",
			"GET /installation/repositories",
			"GET /repos/owner/target/pulls?state=open&per_page=20&sort=updated",
		])
		expect(out).toEqual([
			{ token: "tok-1", repo: "owner/other", pr: { number: 5 } },
			{ token: "tok-2", repo: "owner/target", pr: { number: 5 } },
		])
	})
	test("an empty installation list yields nothing", async () => {
		const api: GhAppClient = {
			request: async () => ({ status: 200, data: [] }),
			installationToken: async () => "tok",
		}
		expect(await gatherOpenPrs(api)).toEqual([])
	})
	test("a non-array installs body yields nothing (transport failure sentinel)", async () => {
		const api: GhAppClient = {
			request: async () => ({ status: 0, data: {} }),
			installationToken: async () => "tok",
		}
		expect(await gatherOpenPrs(api)).toEqual([])
	})
	test("an installation with no token is skipped", async () => {
		const api: GhAppClient = {
			request: async (_method, path) =>
				path === "/app/installations"
					? ({ status: 200, data: [{ id: 1 }] } as any)
					: ({ status: 200, data: { repositories: [{ full_name: "o/r" }] } } as any),
			installationToken: async () => "",
		}
		expect(await gatherOpenPrs(api)).toEqual([])
	})
	test("a missing repositories field is an empty list", async () => {
		const api: GhAppClient = {
			request: async (_method, path) =>
				path === "/app/installations"
					? ({ status: 200, data: [{ id: 1 }] } as any)
					: ({ status: 200, data: {} } as any),
			installationToken: async () => "tok",
		}
		expect(await gatherOpenPrs(api)).toEqual([])
	})
	test("a non-array pulls body contributes nothing", async () => {
		const { api } = appApi({ message: "API rate limit exceeded" })
		expect(await gatherOpenPrs(api)).toEqual([])
	})
})

describe("triggerReview", () => {
	const SECRET = "s3cr3t-webhook-key"
	const REPO = "owner/target"
	const PR = 42
	const NOW = 1_750_000_000

	/**
	 * The payload written INDEPENDENTLY of the implementation, with the Python's
	 * key order (line 431-443). The test signs THIS string and then asserts the
	 * exact bytes sent and the exact header, so neither can drift.
	 */
	const expectedPayload = (installId: number) =>
		JSON.stringify({
			action: "opened",
			number: PR,
			sender: { login: "mytheclipsebotreview", id: 0, type: "Bot" },
			installation: { id: installId },
			pull_request: {
				url: `https://api.github.com/repos/${REPO}/pulls/${PR}`,
				number: PR,
				title: "feat: add a thing",
				state: "open",
				draft: false,
				labels: [],
				head: { sha: "deadbeef", ref: "feat/thing" },
				base: { ref: "main", repo: { full_name: REPO } },
			},
			repository: { full_name: REPO },
		})

	const expectedSig = (payload: string) =>
		`sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`

	/** Fake fetch: records the call, answers 200. */
	function fakeFetch(): { fetchImpl: typeof fetch; calls: { url: string; init: any }[] } {
		const calls: { url: string; init: any }[] = []
		const fetchImpl = (async (url: any, init: any) => {
			calls.push({ url: String(url), init })
			return new Response("", { status: 200 })
		}) as unknown as typeof fetch
		return { fetchImpl, calls }
	}

	function appApi(opts: { installs?: unknown; repos?: unknown; installToken?: string } = {}) {
		const calls: Call[] = []
		const api: GhAppClient = {
			async request(method, path, o) {
				calls.push({ method, path, token: o?.token })
				if (path === "/app/installations") return { status: 200, data: opts.installs ?? [] } as any
				if (path.startsWith("/installation/repositories")) {
					// Only installation 77 owns the target repo, so the walk must pass
					// over 1 and match on 77.
					return {
						status: 200,
						data:
							opts.repos ??
							(o?.token === "itok-77"
								? { repositories: [{ full_name: REPO }] }
								: { repositories: [] }),
					} as any
				}
				return { status: 200, data: {} } as any
			},
			async installationToken(installId: number) {
				return opts.installToken ?? `itok-${installId}`
			},
		}
		return { api, calls }
	}

	test("sends the full synthetic webhook with the exact headers and signature", async () => {
		const { api } = appApi()
		const { fetchImpl, calls } = fakeFetch()
		const r = await triggerReview(
			{ api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
			REPO,
			PR,
			"feat: add a thing",
			"deadbeef",
			"feat/thing",
			"main",
		)
		expect(r).toBe(200)
		expect(calls).toHaveLength(1)
		const { url, init } = calls[0]
		expect(url).toBe("https://hook.test/hook")
		expect(init.method).toBe("POST")
		// Signed over EXACTLY the bytes sent, verified against an HMAC computed
		// here from a payload written out by hand.
		const payload = expectedPayload(0)
		expect(init.body).toBe(payload)
		expect(init.headers["x-hub-signature-256"]).toBe(expectedSig(payload))
		expect(init.headers["x-hub-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/)
		expect(init.headers["x-github-event"]).toBe("pull_request")
		expect(init.headers["x-github-delivery"]).toBe(`cron-${NOW}-${PR}`)
		expect(init.headers["Content-Type"]).toBe("application/json")
	})

	test("the payload carries every field PR-Agent's _check_pull_request_event needs", async () => {
		const { api } = appApi()
		const { fetchImpl, calls } = fakeFetch()
		await triggerReview(
			{ api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
			REPO,
			PR,
			"feat: add a thing",
			"deadbeef",
			"feat/thing",
			"main",
		)
		const body = JSON.parse(calls[0].init.body)
		expect(Object.keys(body)).toEqual([
			"action",
			"number",
			"sender",
			"installation",
			"pull_request",
			"repository",
		])
		expect(body.action).toBe("opened")
		expect(body.number).toBe(PR)
		expect(body.pull_request.url).toBe(`https://api.github.com/repos/${REPO}/pulls/${PR}`)
		expect(body.pull_request.state).toBe("open")
		expect(body.pull_request.draft).toBe(false)
		expect(body.pull_request.labels).toEqual([])
		expect(body.pull_request.head).toEqual({ sha: "deadbeef", ref: "feat/thing" })
		expect(body.pull_request.base).toEqual({ ref: "main", repo: { full_name: REPO } })
		expect(body.repository.full_name).toBe(REPO)
	})

	test("resolves the installation id from the repo's installation", async () => {
		const { api, calls } = appApi({ installs: [{ id: 1 }, { id: 77 }] })
		const { fetchImpl, calls: fetches } = fakeFetch()
		await triggerReview(
			{ api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
			REPO,
			PR,
			"feat: add a thing",
			"deadbeef",
			"feat/thing",
			"main",
		)
		// The walk probes install 1 first, does not match, then matches on 77 —
		// so `/installation/repositories` is fetched TWICE (Python lines 423-428
		// break on match, they do not skip ahead).
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /app/installations",
			"GET /installation/repositories?per_page=100",
			"GET /installation/repositories?per_page=100",
		])
		expect(calls.map((c) => c.token)).toEqual([undefined, "itok-1", "itok-77"])
		// Signature recomputed over the payload that now carries id 77.
		const payload = expectedPayload(77)
		expect(fetches[0].init.body).toBe(payload)
		expect(fetches[0].init.headers["x-hub-signature-256"]).toBe(expectedSig(payload))
	})

	test("a failed installation lookup degrades to id 0 and still posts", async () => {
		const api: GhAppClient = {
			request: async (_method, path) => {
				if (path === "/app/installations") return { status: 200, data: [{ id: 1 }] } as any
				throw new Error("boom")
			},
			installationToken: async () => "itok",
		}
		const { fetchImpl, calls } = fakeFetch()
		const r = await triggerReview(
			{ api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
			REPO,
			PR,
			"t",
			"s",
			"h",
			"b",
		)
		expect(r).toBe(200)
		expect(JSON.parse(calls[0].init.body).installation.id).toBe(0)
	})

	test("a transport failure returns the Python's error string, not a throw", async () => {
		const { api } = appApi()
		const fetchImpl = (async () => {
			throw new Error("connect ECONNREFUSED")
		}) as unknown as typeof fetch
		const r = await triggerReview(
			{ api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
			REPO,
			PR,
			"t",
			"s",
			"h",
			"b",
		)
		expect(r).toBe("error: connect ECONNREFUSED")
	})

	test("the webhook URL and secret default to the Python's config values", async () => {
		const { api } = appApi()
		const { fetchImpl, calls } = fakeFetch()
		// Same arguments `expectedPayload` encodes, so the two payloads are the
		// same bytes and the signature below is a real comparison.
		await triggerReview(
			{ api, fetchImpl, nowSec: NOW },
			REPO,
			PR,
			"feat: add a thing",
			"deadbeef",
			"feat/thing",
			"main",
		)
		expect(calls[0].url).toBe("https://pr-agent.asepharyana.my.id/api/v1/github_webhooks")
		// Default secret is "" — an HMAC over the empty key, not a missing header.
		const payload = expectedPayload(0)
		expect(calls[0].init.body).toBe(payload)
		expect(calls[0].init.headers["x-hub-signature-256"]).toBe(
			`sha256=${createHmac("sha256", "").update(payload).digest("hex")}`,
		)
	})

	test("a non-2xx status is returned verbatim for the caller to judge", async () => {
		const { api } = appApi()
		const fetchImpl = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch
		const r = await triggerReview(
			{ api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
			REPO,
			PR,
			"t",
			"s",
			"h",
			"b",
		)
		expect(r).toBe(403)
	})
})
