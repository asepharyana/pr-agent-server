// LLM handler — 9router via OpenAI-compatible /chat/completions.
// Reflects pr_agent's LiteLLMAIHandler behavior for claude-opus-5:
//   - messages = [{system},{user}]
//   - temperature OMITTED for models in NO_SUPPORT_TEMPERATURE_MODELS
//     (claude-opus-5, claude-sonnet-5 are in that list)
//   - timeout = ai_timeout (600s)
//   - non-streaming (claude-opus-5 not in STREAMING_REQUIRED_MODELS)
//   - raises on empty content
// Returns { content, finishReason, usage }.

import type { Config } from "../config/legacy-config.ts"

export interface ChatResult {
	content: string
	finishReason: string
	/**
	 * The model the endpoint says it ACTUALLY used.
	 *
	 * Distinct from the model we asked for, and the distinction is not academic:
	 * the configured gateway resolves a request for `claude-sonnet-5` through a
	 * `combos` row of the same name whose chain is free-tier models, and answers
	 * `"model": "cat-jam-free"`. Verified 2026-10-21 against the live endpoint —
	 * `claude-opus-5` came back as `deepseek-v4.1-flash-free`, `claude-sonnet-5`
	 * as `cat-jam-free`, and there are ZERO `anthropic` provider connections in
	 * the gateway's DB at all.
	 *
	 * Nothing recorded that, so `reviews.model` read `claude-sonnet-5` for every
	 * review a free model wrote. That is an audit trail asserting something
	 * false, which is worse than no audit trail: the operator lowered their
	 * guard on the strength of an attribution that was never true.
	 */
	servedModel?: string
	usage?: {
		promptTokens?: number
		completionTokens?: number
		totalTokens?: number
		cachedTokens?: number
	}
}

export type ChatCall = (o: {
	model: string
	system: string
	user: string
	temperature?: number
	cfg: Config
}) => Promise<ChatResult>

/**
 * Warn when the endpoint answers with a different model than we asked for.
 *
 * This is not cosmetic. The configured gateway defines `combos` rows named after
 * Claude models whose chains are free-tier models, so a request for
 * `claude-sonnet-5` is answered by `cat-jam-free` while the response still says
 * HTTP 200. Measured 2026-10-21: `claude-opus-5` → `deepseek-v4.1-flash-free`,
 * `claude-sonnet-5` → `cat-jam-free`, and the gateway's DB holds ZERO
 * `anthropic` provider connections, so no Claude model can be reached at all.
 *
 * A silent substitution makes every quality observation meaningless — you cannot
 * reason about "Claude's review was shallow" when Claude never ran. One line per
 * call is enough to make it visible in the logs, and `servedModel` carries the
 * same fact into the database.
 */
function warnOnModelSubstitution(requested: string, served: string | undefined): void {
	if (!served || served === requested) return
	console.warn(
		`[llm] model substituted: requested "${requested}", endpoint served "${served}" — ` +
			"the gateway is answering with a different model than configured",
	)
}

const isTransient = (e: unknown) => {
	const m = String((e as Error)?.message ?? e)
	// An empty body is non-deterministic, not a client error, so the same model
	// must get its retries. Measured against the real prod prompt: the identical
	// request for claude-haiku-4-5 returned an empty `tool_calls` body on 3 of 3
	// attempts in one batch and a clean YAML body on 3 of 3 after the
	// `tool_choice:"none"` fix — i.e. the outcome varies run to run.
	//
	// Without this, one unlucky sample ended the whole model: `break` fell straight
	// through to the next model, and once every configured model had been unlucky
	// once the review failed as "All models failed: Empty content in model
	// response". That is the exact text of all 58 production failures.
	if (/Empty content in model response/.test(m)) return true
	return /LLM request failed \(5\d\d\)|fetch failed|aborted|timeout|timed out|Unable to connect|ECONN|ECONNREFUSED|socket/i.test(
		m,
	)
}

export async function callWithFallback(opts: {
	models: string[]
	system: string
	user: string
	temperature?: number
	cfg: Config
	retries?: number
	call?: ChatCall
	/**
	 * Judge a response BODY, not just the HTTP round trip.
	 *
	 * WHY THIS EXISTS. `callWithFallback` only knew about transport failures, so a
	 * 200 whose content was unusable counted as success and the fallback models
	 * were never tried. For the review tool that meant an unparseable-but-valid
	 * YAML body ended the whole review — "All models failed: failed to parse
	 * review response into markdown" — even though two more models were configured
	 * and would very likely have answered cleanly. The YAML was also
	 * non-deterministic: the same model and prompt parsed on one run and not the
	 * next, so the outcome depended on which sample happened to arrive first.
	 *
	 * Returning a string makes this response a failure and the loop moves to the
	 * next model (reason included in the final error). Returning null accepts it.
	 * A THROW is treated as a rejection, same as a failed call, so a validator can
	 * simply assert.
	 *
	 * This is what makes the fallback chain mean something: the unit that varies
	 * across attempts is the RESPONSE, not just the connection.
	 */
	validate?: (content: string, model: string) => string | null
	/**
	 * Extra instruction appended to the user turn when a BODY was rejected but
	 * the call itself succeeded — a format correction, not a transport retry.
	 *
	 * WHY THIS EXISTS. A rejected body was retried with the byte-identical
	 * prompt, so a model that answered in prose had no reason to comply on the
	 * second attempt: it had already complied, as far as it could tell. Measured
	 * on 2026-10-28 against the real 8KB review prompt, `claude-opus-5-5` and
	 * `claude-sonnet-5-5` replied in prose on 12 of 12 calls and never produced
	 * the YAML body the prompt asks for, so every retry burned a paid call and
	 * failed the same way. The review then never posted, and because the
	 * webhook had already returned 2xx the worker saw only "accepted, no review"
	 * and reported the PR as pending forever — the hang this parameter fixes.
	 *
	 * Returned text is appended AFTER the original user turn so the model keeps
	 * the full task and gains only the correction.
	 */
	repair?: (complaint: string, attempt: number) => string | null
}) {
	const call = opts.call ?? chatCompletion
	const retries = opts.retries ?? 2
	let last: unknown
	const rejected: string[] = []
	for (const model of opts.models) {
		// The correction for THIS model's rejections, applied to the next attempt.
		// Held per model so a reason found on one model never leaks into another's
		// prompt.
		let repairText: string | null = null
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const r = await call({
					model,
					system: opts.system,
					user: repairText ? `${opts.user}\n\n${repairText}` : opts.user,
					temperature: opts.temperature,
					cfg: opts.cfg,
				})
				if (opts.validate) {
					let complaint: string | null = null
					try {
						complaint = opts.validate(r.content, model)
					} catch (e) {
						complaint = e instanceof Error ? e.message : String(e)
					}
					if (complaint) {
						// A body this model could not get right is not a transport
						// fault: retrying the SAME model may well fix it (the outputs
						// are non-deterministic), so it keeps its retries and only
						// moves on once they are spent.
						//
						// `repair` improves those retries but does not gate them. When
						// it supplies a correction the retry asks for the format that
						// was missing; when it does not, the retry is unchanged and
						// still a fair second sample — the same prompt that parsed on
						// one run can parse on the next because the model is not
						// deterministic. Refusing to retry would throw away that
						// chance, which is the case `keeps its retries` pins.
						rejected.push(`${model}: ${complaint}`)
						last = new Error(complaint)
						if (attempt === retries) break
						repairText = opts.repair?.(complaint, attempt) ?? repairText
						await new Promise((r2) => setTimeout(r2, 1000 * 2 ** attempt))
						continue
					}
				}
				warnOnModelSubstitution(model, r.servedModel)
				return {
					content: r.content,
					model,
					// Propagate what the endpoint actually served. `model` above is
					// what we ASKED for and must stay that way — it keys the retry
					// chain — but the caller needs the truth for the audit trail.
					servedModel: r.servedModel,
					usage: {
						promptTokens: r.usage?.promptTokens ?? 0,
						completionTokens: r.usage?.completionTokens ?? 0,
						cachedTokens: r.usage?.cachedTokens ?? 0,
					},
				}
			} catch (e) {
				last = e
				if (!isTransient(e) || attempt === retries) break
				await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
			}
		}
	}
	// Every model's own reason is more useful than the last one alone: the caller
	// used to see only the final complaint and could not tell a bad body from a
	// dead endpoint.
	throw new Error(
		`All models failed: ${(last as Error)?.message ?? "unknown"}` +
			(rejected.length > 1 ? ` (rejected: ${rejected.join("; ")})` : ""),
	)
}

const NO_SUPPORT_TEMPERATURE_MODELS = new Set([
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"anthropic/claude-opus-5",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	"anthropic/claude-sonnet-5",
	"claude-haiku-4-5-20251001",
	"anthropic/claude-haiku-4-5-20251001",
	"o1",
	"o1-mini",
	"o1-preview",
	"o3",
	"o3-mini",
	"o4-mini",
	"gpt-5.1-codex",
	"gpt-5.2-codex",
	"gpt-5-mini",
	"deepseek/deepseek-reasoner",
])

export async function chatCompletion(opts: {
	model: string
	system: string
	user: string
	temperature?: number
	maxTokens?: number
	cfg: Config
	signal?: AbortSignal
}): Promise<ChatResult> {
	const { model, system, user, temperature, cfg } = opts
	const messages: Record<string, string>[] = []
	if (system) messages.push({ role: "system", content: system })
	messages.push({ role: "user", content: user })

	const body: Record<string, unknown> = {
		model,
		messages,
		stream: false,
		// `tool_choice: "none"` is NOT a no-op, and it is load-bearing.
		//
		// WHY: every review in production was dying with
		// `Empty content in model response (finish_reason: tool_calls)` — 58 of 58
		// failures over 7 days, across 10 different PRs. This request sends no
		// `tools` at all, yet the upstream answered with a fabricated call:
		//
		//   finish_reason: "tool_calls"
		//   tool_calls: [{ name: "shell",
		//                  arguments: '{"command":"cd /app; ls -la; git log ..."}' }]
		//
		// i.e. the model invented a shell tool nobody offered and put its entire
		// answer into that call, leaving `content` empty. Measured against the
		// real prod prompt, 3 attempts per model: claude-haiku-4-5 failed 3/3
		// with the baseline body and 0/3 with `tool_choice:"none"`. sonnet was
		// unaffected, opus never reproduced it — which is exactly why this hid
		// for so long: it depends on which fallback model answers.
		//
		// `tools: []` alone does NOT fix it (2/3 still empty) — the explicit
		// `tool_choice` is what the endpoint honours.
		//
		// This is a text-completion path; it never wants a tool call. Verified
		// the YAML body is unchanged by the flag before adopting it.
		tool_choice: "none",
	}
	// temperature omitted for models that don't support it (incl. claude-opus-5)
	const isNoTemp = NO_SUPPORT_TEMPERATURE_MODELS.has(model)
	if (temperature !== undefined && !isNoTemp) {
		body.temperature = temperature
	}
	if (opts.maxTokens) body.max_tokens = opts.maxTokens

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), cfg.aiTimeoutMs || 600000)
	if (opts.signal) {
		opts.signal.addEventListener("abort", () => controller.abort(), { once: true })
	}

	try {
		const resp = await fetch(`${cfg.llm.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.llm.apiKey}`,
				...cfg.llm.extraHeaders,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		})

		if (!resp.ok) {
			let detail = ""
			try {
				const errJson = (await resp.json()) as { error?: { message?: string } }
				detail = errJson.error?.message || ""
			} catch {
				detail = await resp.text()
			}
			throw new Error(`LLM request failed (${resp.status}): ${detail || resp.statusText}`)
		}
		const data = (await resp.json()) as {
			model?: string
			choices?: { message?: { content?: string | null }; finish_reason?: string }[]
			usage?: {
				prompt_tokens?: number
				completion_tokens?: number
				total_tokens?: number
				prompt_tokens_details?: { cached_tokens?: number }
			}
		}

		const choice = data.choices?.[0]
		const content = choice?.message?.content ?? ""
		if (!content) {
			throw new Error(
				`Empty content in model response (finish_reason: ${choice?.finish_reason ?? "?"})`,
			)
		}
		return {
			content,
			finishReason: choice?.finish_reason ?? "stop",
			// What the gateway says it served. Kept separate from the requested
			// model so the caller can record the truth; undefined when the
			// endpoint omits it.
			servedModel: typeof data.model === "string" ? data.model : undefined,
			usage: data.usage
				? {
						promptTokens: data.usage.prompt_tokens,
						completionTokens: data.usage.completion_tokens,
						totalTokens: data.usage.total_tokens,
						cachedTokens: data.usage.prompt_tokens_details?.cached_tokens,
					}
				: undefined,
		}
	} finally {
		clearTimeout(timeout)
	}
}
