// PR Review tool — orchestrates the whole review: fetch PR, build diff,
// render prompts, call LLM, parse YAML, render markdown, publish.
// Port of pr_agent.tools.pr_reviewer.

import type { Config } from "../../infrastructure/config/legacy-config.ts"
import { GitHubProvider } from "../../infrastructure/github/index.ts"
import { callWithFallback } from "../../infrastructure/llm/llm.ts"
import { convertToMarkdownV2 } from "../core/markdown.ts"
import { renderTemplate } from "../core/render.ts"
import { isFormatRejection, REVIEW_FORMAT_REPAIR } from "../core/review-format.ts"
import { countPromptTokens } from "../core/token.ts"
import { loadYaml } from "../core/yaml.ts"
import { clipTokens, getPrDiff } from "../diff/index.ts"
import { REVIEW_SYSTEM_TEMPLATE, REVIEW_USER_TEMPLATE } from "../prompts/review.ts"
import { analyseDependencyPr, renderDependencyFacts } from "./dependency-facts.ts"
import { publishPersistent } from "./publish.ts"

export interface ReviewResult {
	markdown: string
	data: Record<string, unknown> | null
	model: string
	/**
	 * The model the LLM endpoint reported it actually served, when it says.
	 *
	 * `model` is what we ASKED for. On the configured gateway those differ: the
	 * gateway resolves `claude-sonnet-5` through a same-named `combos` row whose
	 * chain is free-tier models, so the answer comes back attributed to
	 * `cat-jam-free` and no `anthropic` connection exists at all. Recording only
	 * the requested name made the dashboard claim every review was written by
	 * Claude, which is the opposite of an audit trail.
	 */
	servedModel?: string
	promptTokens: number
	completionTokens: number
	cachedTokens: number
	remainingFiles: string[]
	diff: string
	status: string
	/**
	 * The head SHA this review actually read.
	 *
	 * Returned so the caller can record history against the commit it describes.
	 * The dashboard's `reviews` table has a `head_sha` column for exactly this,
	 * and without it a stored row could not be matched to the commit it judged.
	 */
	headSha: string
}

export async function runReview(
	cfg: Config,
	repoOwner: string,
	repoName: string,
	prNumber: number,
	privateKeyPem: string,
	opts?: {
		publish?: boolean
		extraInstructions?: string
	},
): Promise<ReviewResult> {
	const provider = new GitHubProvider(cfg, repoOwner, repoName, prNumber, privateKeyPem)
	const pr = await provider.getPr()
	const files = await provider.getDiffFiles()

	// main language
	let languages: Record<string, number> = {}
	try {
		languages = await provider.getLanguages()
	} catch {
		languages = {}
	}
	const mainLanguage = getMainPrLanguage(languages, files)

	const description = await provider.getPrDescription(true)
	const branch = await provider.getPrBranch()
	const commitMessagesStrRaw = await provider.getCommitMessagesStr(cfg.maxCommitsTokens)
	const commitMessagesStr = clipTokens(commitMessagesStrRaw, cfg.maxCommitsTokens)
	const title = pr.title
	const date = new Date().toISOString().slice(0, 10)

	const r = cfg.prReviewer
	const vars: Record<string, unknown> = {
		title,
		branch,
		description,
		language: mainLanguage,
		diff: "",
		num_pr_files: files.length,
		num_max_findings: r.numMaxFindings,
		require_score: r.requireScoreReview,
		require_tests: r.requireTestsReview,
		require_estimate_effort_to_review: r.requireEstimateEffortToReview,
		require_estimate_contribution_time_cost: r.requireEstimateContributionTimeCost,
		require_can_be_split_review: r.requireCanBeSplitReview,
		require_security_review: r.requireSecurityReview,
		require_todo_scan: r.requireTodoScan,
		question_str: "",
		answer_str: "",
		extra_instructions: opts?.extraInstructions ?? r.extraInstructions,
		skills_context: "",
		repo_context: "",
		commit_messages_str: commitMessagesStr,
		custom_labels: "",
		enable_custom_labels: false,
		is_ai_metadata: false,
		related_tickets: [],
		duplicate_prompt_examples: false,
		date,
	}

	// prompt tokens
	const promptTokens = countPromptTokens(
		REVIEW_SYSTEM_TEMPLATE,
		REVIEW_USER_TEMPLATE,
		vars,
		renderTemplate,
	)

	// build diff with token budget (reuses prompt tokens); main-language files
	// are ordered first inside getPrDiff using the languages fetched above
	const { diff, remainingFiles } = getPrDiff(files, promptTokens, cfg.modelReview, cfg, languages)

	// render final prompts with diff
	const systemPrompt = renderTemplate(REVIEW_SYSTEM_TEMPLATE, { ...vars, diff })
	const userPrompt = renderTemplate(REVIEW_USER_TEMPLATE, { ...vars, diff })

	// parse YAML (resilient)
	const keysFix = [
		"ticket_compliance_check",
		"estimated_effort_to_review_[1-5]:",
		"security_concerns:",
		"key_issues_to_review:",
		"relevant_file:",
		"relevant_line:",
		"suggestion:",
	]

	/**
	 * Parse one response and render it, or return null if it is unusable.
	 *
	 * Parsing is NOT a transport concern, so it is fed to `callWithFallback` as a
	 * `validate` hook: an unparseable-but-HTTP-200 body now moves on to the next
	 * configured model instead of failing the whole review on the first sample.
	 *
	 * This matters because the models' YAML is non-deterministic — the same model
	 * and prompt parse on one run and not the next — so any single sample is a
	 * coin flip. Falling through the chain turns that coin flip into "one of N
	 * samples was usable", which is the difference between reviews landing and
	 * reviews failing at random.
	 */
	const render = (content: string): { markdown: string; data: Record<string, unknown> } | null => {
		let parsed = loadYaml(content, keysFix, "review", "security_concerns") as Record<
			string,
			unknown
		> | null
		// loadYaml returns { review: ... } — keep as is
		if (parsed && !("review" in parsed) && "review" in (parsed as object)) {
			parsed = { review: (parsed as { review: unknown }).review }
		}
		if (!parsed || !("review" in parsed)) return null
		const md = convertToMarkdownV2(
			parsed as { review: Record<string, unknown> },
			true,
			r.enableIntroText,
		)
		return md ? { markdown: md, data: parsed } : null
	}

	// LLM call with per-model retry + fallback models. A body that will not parse
	// is treated as a failed attempt, so the remaining models get their turn.
	const llm = await callWithFallback({
		models: [cfg.modelReview, ...cfg.fallbackModels],
		system: systemPrompt,
		user: userPrompt,
		temperature: cfg.temperature,
		cfg,
		validate: (content) =>
			render(content) === null ? "failed to parse review response into markdown" : null,
		// The models that fail here do not emit broken YAML, they emit PROSE —
		// measured 0/10 with a `review:` body on the real prompt, and 10/10 once
		// this correction was appended (2026-10-28, both Claude 5.5 ids). Re-sending
		// the identical prompt reproduces the prose; naming the format fixes it.
		repair: (complaint) => (isFormatRejection(complaint) ? REVIEW_FORMAT_REPAIR : null),
	})

	// Re-render the accepted body. `validate` guarantees this is non-null; the
	// guard below is the belt-and-braces check that a malformed response is never
	// reported as a completed review with a 0-char comment.
	const accepted = render(llm.content)
	if (!accepted) {
		throw new Error("All models failed: failed to parse review response into markdown")
	}
	const { markdown, data } = accepted

	// SAY SO when the diff was too large to review whole.
	//
	// `getPrDiff` drops files once the prompt budget is spent and reports them in
	// `remainingFiles`, but nothing ever surfaced that: the review was published
	// as if it had covered the whole PR. The reader of the comment — the person
	// deciding whether to merge — had no way to know that part of the diff was
	// never looked at. A partial review presented as a complete one is worse than
	// an obviously missing one, because it reads as approval of code nobody read.
	//
	// Measured before this: a PR of ~5000 changed lines (~128k tokens) hit the
	// 128k cap and was silently compressed to a subset.
	// Compute the dependency movement BEFORE the model is asked anything.
	//
	// A version bump is mechanically knowable, so it must not depend on a model's
	// reading of a 500-line lockfile diff. On asepharyana/GMW#119 the model
	// returned "No key issues identified" at score 95 for two version bumps; the
	// facts below say which packages moved, by how much, and whether the lockfile
	// kept up — and they are true regardless of which model answers, or whether
	// the gateway substitutes a weaker one.
	const depReport = analyseDependencyPr(files)
	const depFacts = renderDependencyFacts(depReport)

	const published =
		remainingFiles.length > 0 ? `${markdown}\n\n${largePrNotice(remainingFiles)}` : markdown

	// Prepend the computed facts for a dependency PR. Placed ABOVE the model's
	// table because it is the reliable half of the review: whatever the model
	// concluded, the reader can see exactly what moved.
	const withFacts = depFacts ? `${depFacts}\n\n${published}` : published

	// publish
	if (opts?.publish !== false) {
		if (withFacts) {
			// persistent comment (replace prev "## PR Reviewer Guide 🔍")
			if (r.persistentComment) {
				await publishPersistent(
					provider,
					withFacts,
					"## PR Reviewer Guide 🔍",
					"review",
					r.finalUpdateMessage,
				)
			} else {
				await provider.publishComment(withFacts)
			}
		}
	}

	return {
		// The published body, facts and notice included: this is what the PR
		// actually shows, so history and the dashboard must record the same text
		// the reader saw.
		markdown: withFacts,
		data,
		model: llm.model,
		servedModel: llm.servedModel,
		promptTokens: llm.usage.promptTokens || promptTokens,
		completionTokens: llm.usage.completionTokens,
		cachedTokens: llm.usage.cachedTokens,
		remainingFiles,
		diff,
		status: "success",
		// Already fetched at the top of this function for the diff; no extra
		// round-trip. `pr.head.sha` is the commit the prompt was built from.
		headSha: pr.head.sha,
	}
}

/**
 * The disclosure appended to the comment when part of the diff was not sent.
 *
 * Deliberately explicit about the count and names, and deliberately NOT phrased
 * as a warning banner: the point is that a reader can tell which files were
 * never reviewed, not that they should panic. Listing is capped because a
 * 500-file truncation would bury the review it is annotating.
 */
export function largePrNotice(remainingFiles: string[]): string {
	const shown = remainingFiles.slice(0, 20)
	const more = remainingFiles.length - shown.length
	const list = shown.map((f) => `- \`${f}\``).join("\n")
	const overflow = more > 0 ? `\n- …and ${more} more` : ""
	return [
		"---",
		"",
		`**⚠️ Partial review — ${remainingFiles.length} file(s) were not analysed.**`,
		"",
		"This PR's diff exceeded the prompt budget, so the files below were dropped",
		"before the review ran. Their contents were never seen by the model, and any",
		"assessment above does not cover them.",
		"",
		list + overflow,
	].join("\n")
}

function getMainPrLanguage(
	languages: Record<string, number>,
	files: { filename: string }[],
): string {
	if (!languages || Object.keys(languages).length === 0 || !files.length) return ""
	const top = Object.entries(languages)
		.sort((a, b) => b[1] - a[1])[0][0]
		.toLowerCase()
	const ext = files[0].filename.split(".").pop()?.toLowerCase() ?? ""
	const map: Record<string, string> = {
		python: "Python",
		typescript: "TypeScript",
		javascript: "JavaScript",
		go: "Go",
		rust: "Rust",
		java: "Java",
		csharp: "C#",
		cpp: "C++",
		ruby: "Ruby",
		php: "PHP",
		swift: "Swift",
		kotlin: "Kotlin",
		shell: "Shell",
		html: "HTML",
		css: "CSS",
		vue: "Vue",
		scala: "Scala",
	}
	const extLang: Record<string, string> = {
		py: "python",
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		go: "go",
		rs: "rust",
		java: "java",
		cs: "csharp",
		cpp: "cpp",
		rb: "ruby",
		php: "php",
		swift: "swift",
		kt: "kotlin",
		sh: "shell",
		bash: "shell",
		html: "html",
		css: "css",
		vue: "vue",
		scala: "scala",
	}
	const langOfExt = extLang[ext] || ""
	if (langOfExt && langOfExt === top) return map[top] || top
	return langOfExt ? map[langOfExt] || langOfExt : map[top] || top
}
