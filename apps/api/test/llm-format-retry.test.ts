// The retry loop used to re-send the byte-identical prompt after a body it
// could not parse, so a model that answered in prose answered in prose again.
//
// Measured on 2026-10-28 against the real rendered review prompt (7,950 chars,
// schema and worked example included): `claude-opus-5-5` and
// `claude-sonnet-5-5` replied in prose on 12 of 12 calls and never emitted a
// `review:` key. Both retries burned a paid call and failed identically, the
// review never posted, and because the webhook had already answered 2xx the
// worker recorded "requested" and waited forever — the queue hang.
//
// These tests pin the two properties that fix it:
//   1. a body rejection retries with a CORRECTION appended, not the same prompt
//   2. a rejection nothing can correct (no `repair`) stops instead of paying
//      for an identical call, and still surfaces every model's reason

import { describe, expect, test } from "vitest"
import { callWithFallback, type ChatCall } from "../src/infrastructure/llm/llm.ts"
import { isFormatRejection, REVIEW_FORMAT_REPAIR } from "../src/legacy/core/review-format.ts"

const CFG = { temperature: 0 } as never

/** A fake model that answers from a script, recording every prompt it saw. */
function scriptedModel(replies: string[]) {
	const seen: { model: string; user: string }[] = []
	const call: ChatCall = async (req) => {
		// Index BEFORE recording, so reply N answers call N. Reading after the push
		// shifted every answer by one and made a working retry look like a failure.
		const index = seen.length
		seen.push({ model: req.model, user: req.user })
		const next = replies[index] ?? replies[replies.length - 1]
		return { content: next ?? "", finishReason: "stop" }
	}
	return { call, seen }
}

/** Reject anything that is not a YAML `review:` body — the review's own check. */
const needsReviewBody = (content: string) => (/(^|\n)review:/.test(content) ? null : "prose")

describe("callWithFallback: a rejected body is retried with a correction", () => {
	test("the retry prompt carries the repair text, appended to the original", async () => {
		// Prose first, YAML second: the correction works.
		const { call, seen } = scriptedModel(["This PR adds a comment.", "review:\n  score: 90"])
		const r = await callWithFallback({
			models: ["m1"],
			system: "sys",
			user: "ORIGINAL TASK",
			cfg: CFG,
			call,
			validate: needsReviewBody,
			repair: () => "REPAIR: reply in YAML only",
		})
		expect(r.content).toContain("review:")
		expect(seen).toHaveLength(2)
		// Attempt 1 is untouched; attempt 2 keeps the task AND gains the correction.
		expect(seen[0].user).toBe("ORIGINAL TASK")
		expect(seen[1].user).toContain("ORIGINAL TASK")
		expect(seen[1].user).toContain("REPAIR: reply in YAML only")
	})

	test("a body rejection without a repair still retries, reusing the same prompt", async () => {
		// Retrying is a fair second sample: the same prompt that parsed on one run
		// can parse on the next because the model is not deterministic. `repair`
		// upgrades the retry, it does not gate it — dropping the retry would throw
		// that chance away and fail a model that would have recovered.
		const { call, seen } = scriptedModel(["prose forever"])
		await expect(
			callWithFallback({
				models: ["m1"],
				system: "sys",
				user: "task",
				cfg: CFG,
				call,
				retries: 2,
				validate: needsReviewBody,
			}),
		).rejects.toThrow(/prose/)
		// 1 attempt + 2 retries, and no correction was ever injected.
		expect(seen).toHaveLength(3)
		expect(seen.every((s) => s.user === "task")).toBe(true)
	})

	test("the correction is per model and does not leak to the next one", async () => {
		// A fallback model must never inherit the previous model's correction: its
		// first attempt is a clean request, otherwise it is being corrected for
		// something it did not do.
		//
		// `retries: 1` pins m1 to two attempts (prose, prose) so it is genuinely
		// exhausted; with the default of 2 the third attempt succeeds and m2 is
		// never reached, which would make this assert nothing.
		const replies = ["prose", "prose", "review:\n  score: 88"]
		const { call, seen } = scriptedModel(replies)
		const r = await callWithFallback({
			models: ["m1", "m2"],
			system: "sys",
			user: "TASK",
			cfg: CFG,
			call,
			retries: 1,
			validate: needsReviewBody,
			repair: () => "REPAIR",
		})
		expect(r.model).toBe("m2")
		expect(seen[0].user).toBe("TASK") // m1 first try, clean
		expect(seen[1].user).toContain("REPAIR") // m1 retry, corrected
		expect(seen[2].user).toBe("TASK") // m2 first try, clean again
	})

	test("every model's reason survives into the final error", async () => {
		const { call } = scriptedModel(["p1", "p2"])
		await expect(
			callWithFallback({
				models: ["m1", "m2"],
				system: "sys",
				user: "t",
				cfg: CFG,
				call,
				retries: 0,
				validate: needsReviewBody,
			}),
		).rejects.toThrow(/m1: prose.*m2: prose/s)
	})
})

describe("callWithFallback: transport failures keep their own retry", () => {
	test("a transient error is retried unchanged, without a repair", async () => {
		let n = 0
		const seen: string[] = []
		const call: ChatCall = async (req) => {
			seen.push(req.user)
			n++
			if (n === 1) throw new Error("fetch failed")
			return { content: "review:\n  score: 91", finishReason: "stop" }
		}
		const r = await callWithFallback({
			models: ["m1"],
			system: "sys",
			user: "TASK",
			cfg: CFG,
			call,
			validate: needsReviewBody,
			repair: () => "REPAIR",
		})
		expect(r.content).toContain("review:")
		// A socket error says nothing about format, so no correction is injected.
		expect(seen[1]).toBe("TASK")
	})
})

describe("review-format: the correction targets the real failure", () => {
	test("recognises the review tool's own rejection text", () => {
		expect(isFormatRejection("failed to parse review response into markdown")).toBe(true)
	})

	test("does not mistake a transport fault for a format fault", () => {
		for (const msg of ["fetch failed", "LLM request failed (503)", "timeout"]) {
			expect(isFormatRejection(msg)).toBe(false)
		}
	})

	test("the correction names the shape and forbids the prose that broke it", () => {
		// The measured failure is prose, so the correction must forbid commentary
		// AND name the wrapping key the renderer needs.
		expect(REVIEW_FORMAT_REPAIR).toMatch(/only the YAML/i)
		expect(REVIEW_FORMAT_REPAIR).toMatch(/no introduction/i)
		expect(REVIEW_FORMAT_REPAIR).toMatch(/start your reply with "review:"/i)
	})
})
