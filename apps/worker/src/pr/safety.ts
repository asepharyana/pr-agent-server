/**
 * PR-Agent review safety analysis — port of `scripts/pr-queue-worker.py`
 * lines 352-391 (`analyze_review_safety`).
 *
 * The worker will not AI-fix or merge a PR unless the bot's review body says
 * it is safe. This module is that gate: it scores the body and blocks on the
 * two conditions that make a review untrustworthy (a generator error, or a
 * real security / breaking-change finding).
 *
 * TWO REGEX FACTS THIS PORT DOES NOT CHANGE. They are most of the module:
 *
 * 1. THE DOT IS LINE-SCOPED, for the PHRASE patterns. Neither Python's `.` nor
 *    JS's `.` matches a newline, so every `⚡`/`🧪`/`⏱️` phrase pattern can only
 *    see the line the emoji is on. Do not add the `s` flag to those.
 *
 * 2. THE PHRASE FLAGS ARE ASYMMETRIC, and that is intentional. The "danger"
 *    patterns are case-insensitive (the bot may write "Security concern" or
 *    "security concerns"); the "clear" patterns are NOT, because their wording
 *    is load-bearing — `No major issues detected` must match literally, and
 *    lowercasing would also make a negated line match.
 *
 * THE `🔒` ROW IS THE ONE PLACE THAT IS NO LONGER PHRASE-MATCHED. It used to be,
 * and it was wrong in a way that cost a merge: the renderer can emit a
 * negation it failed to recognise (`No` plus a leaked code fence) under the
 * bare "Security concerns" HEADING, and a pattern requiring the phrase after
 * the emoji read that shape as safe. `readSecurityRow` below reads the row's
 * content instead. `SEC_ROW` uses `[\s\S]` for the opposite reason — it is
 * reading a whole row, not a phrase on one line.
 *
 * The effort pattern is LAZY (`.*?(\d+)`): it takes the FIRST digit on the
 * ⏱️ line, which is the rating, not any number the surrounding prose mentions.
 * The rating is the score knob, so a greedy `.*(\d+)` would read a different
 * number and silently change which PRs count as large.
 */

/** Python's `(safe, reasons, score)` triple, as an object. */
export type SafetyResult = { safe: boolean; reasons: string[]; score: number }

/** Python's starting score (line 355). */
const BASE_SCORE = 5
/** The pass threshold, applied AFTER clamping (Python line 391). */
const SAFE_THRESHOLD = 6

/**
 * Python line 357, verbatim and in order. The first hit wins and short-circuits
 * the whole analysis with score 0 — a body that failed to generate has no
 * meaningful sections to score.
 */
const ERROR_PATTERNS = [
	"Failed to generate",
	"Error during",
	"RetryError",
	"traceback",
	"Internal Server Error",
] as const

/**
 * The verdict a `🔒` row carries: `clear` (the reviewer found nothing),
 * `remediated` (the row says the UPDATE fixes security problems rather than
 * introducing them), `concern` (it reported something in THIS code), or
 * `absent` (no such row in the body).
 */
export type SecurityVerdict = "clear" | "remediated" | "concern" | "absent"

/**
 * A row that describes the update REMEDIATING security problems, not a finding
 * in this code.
 *
 * THE BUG THIS EXISTS FOR. A dependency-bump review answers the security
 * question about the BUMP, not about the repository, so its "Yes" means "yes,
 * this update contains security fixes". mcpedia#48's body says, in full:
 *
 *   🔒 Security concerns → `Yes. Hono security fixes.`
 *
 * which the gate read as `concern` and blocked at 0/10 — a security UPDATE
 * refused because it is a security update. Every other shape in that row
 * ("SQL injection in src/auth.ts", "Yes - TLS certificate trust issue") really
 * is a finding, so the phrase alone cannot decide it; the sentence has to be
 * read for the direction of the claim.
 *
 * WHAT MAKES THIS SAFE TO WIDEN. A remediation reading is only granted when the
 * row names no risk language AT ALL — see `RISK_MARKER`. The long mcpedia#48
 * body describes "path bypass", "CSRF bypass" and "crafted requests", so it
 * still blocks and is retired by the ceiling instead of looping. The asymmetry
 * is deliberate: a false `concern` costs a closed PR a human can re-open, and a
 * false `clear` merges a vulnerability. Only the unambiguously positive reading
 * is promoted, and the reason line says which reading was taken so the report
 * never claims a clean review it did not see.
 */
const REMEDIATION =
	/\b(?:security|vulnerabilit(?:y|ies)|cve[-\s]?\d*)\b[^.]{0,48}?\b(?:fix|fixes|fixed|patch|patches|patched|remediat\w*|address\w*|resolv\w*|harden\w*|mitigat\w*)\b/i

/**
 * Any of these in the row means it is describing a weakness, so the remediation
 * reading is refused. Kept as a plain word list rather than a parser: the gate
 * only needs to answer "did the reviewer name something dangerous", and an
 * unrecognised danger word must fall through to the blocking default.
 */
const RISK_MARKER =
	/\b(?:injection|xss|csrf|ssrf|rce|leak\w*|expos\w*|exploit\w*|bypass\w*|vulnerab\w*|insecure|unsafe|trust issue|certificate|hardcod\w*|secret|credential|auth(?:entication|orization)? bypass|privilege|traversal|overflow|dos|denial)\b/i

/**
 * Words that make a sentence a DEMAND about this PR rather than a description of
 * the update. `needs`, `should`, `must`, `requires` all point at work still to be
 * done here, so a row containing one is never a remediation reading.
 *
 * THIS CLOSES A FALSE CLEAR, measured rather than imagined. Without it,
 * `"Yes, this needs a security fix before merging"` — a real finding in this code
 * — matched `REMEDIATION` (the words "security" and "fix" sit close together) and
 * contained no risk noun, so it was promoted to `remediated` and the PR could be
 * merged. The obligation words are what separate "the update fixes X" from "we
 * must fix X".
 */
const OBLIGATION =
	/\b(?:need(?:s|ed)?|should|must|require(?:s|d)?|ought|todo|to be fixed|before merg\w*)\b/i

/**
 * Does this row read as "the update fixes security problems"?
 *
 * THREE halves are required, and each one was earned by a measurement:
 *   - a remediation phrase (`REMEDIATION`);
 *   - NO risk language at all (`RISK_MARKER`) — "the hono bump patches the
 *     middleware bypass" names a weakness, so it stays a finding; and
 *   - NO obligation language (`OBLIGATION`) — "needs a security fix" is a demand
 *     about this PR, not a description of the dependency.
 *
 * The asymmetry is the point: a false `concern` closes a PR a human can re-open,
 * a false clear merges a vulnerability. So the gate only ever promotes the
 * unambiguously positive reading, and everything it refuses stays blocked.
 *
 * NOT COVERED HERE, and deliberately left alone: a row that OPENS with a
 * negation is resolved by `SEC_NEGATION` before this function runs, so
 * "No security fixes needed, but SQL injection in src/auth.ts" still reads as
 * clean. That is a pre-existing hole in the negation rule (measured against the
 * code before this change — it behaves identically there), and fixing it means
 * deciding what a negation followed by real prose means, which is a separate
 * question from the one this function answers. Naming it here so the next reader
 * does not mistake this guard for a complete defence.
 */
function readsAsRemediation(detail: string): boolean {
	return REMEDIATION.test(detail) && !RISK_MARKER.test(detail) && !OBLIGATION.test(detail)
}

/**
 * The boundary of one review section: a cell close (`</td>`), an `### ` heading,
 * or the next emoji-led row heading.
 *
 * NEITHER a bare newline NOR a blank line is a boundary, and each was tried and
 * was wrong in a different way:
 *
 *   - `\n` ends the row at the renderer's own `<br><br>` line break, so the
 *     content comes back empty and an empty row reads as "clean" — a review
 *     reporting a real SQL injection passed.
 *   - `\n\s*\n` looks safer and is worse: the table renderer emits
 *     `</strong><br><br>\n\n` between a row's HEADING and its CONTENT, so that
 *     IS a blank line, and the row was truncated to its heading before the
 *     verdict was ever read.
 *
 * The general rule: a boundary must be something the format emits ONLY when a
 * section ends. `</td>` and the next emoji heading are exactly that.
 */
const SEC_SECTION_END = /<\/td>|^\s*###\s|\n\s*(?:🔒|⚡|🧪|⏱️|🏅|🔫|📝|🔀|✨|🎫|🔍)\s/m

/**
 * The verdict words a model's YAML produced for "nothing wrong here". Matched
 * against the row's CONTENT with the heading already stripped, so the leading
 * word is the verdict and any prose after it cannot flip the reading.
 */
const SEC_NEGATION = /^(?:no|none|n\/a|na)\b/i

/**
 * Read the `🔒` row's VERDICT rather than matching a phrase in it.
 *
 * The renderer emits this row in three shapes and a phrase-matching gate can
 * only recognise one of them:
 *
 *   clear    → `🔒&nbsp;<strong>No security concerns identified</strong>`
 *   concern  → `🔒&nbsp;<strong>Security concerns</strong><br><br>\n\n<real prose>`
 *   degenerate → `🔒&nbsp;<strong>Security concerns</strong><br><br>\n\nNo\n``` `
 *              — a NEGATION the renderer failed to recognise as one, so it fell
 *              into the `concern` template and emitted the heading followed by
 *              a negation. This is GMW#109, byte for byte.
 *
 * A gate keyed on the literal phrase `Security concern` reads the third shape
 * as "no concern found" — the exact opposite of its meaning — because the
 * heading sits BEFORE the emoji's line ends and nothing after it repeats the
 * phrase. So the verdict is computed from the row's CONTENT: strip the heading,
 * and if what remains is a negation (or nothing at all), it is clean. Everything
 * else is a concern.
 *
 * This inverts the failure mode. The old default for an unrecognised shape was
 * "unclear", which the caller scored as a point off and, on the `⚡` row, as a
 * hard block; here an unrecognised shape is a block, and only an explicitly
 * empty or negated one is a pass. A shape we have never seen cannot buy a merge.
 *
 * `SEC_ROW` is non-greedy to the row terminator, so it captures one row and
 * not the rest of the table — a second `🔒` further down cannot overwrite this
 * row's verdict.
 */
function readSecurityRow(body: string): { verdict: SecurityVerdict; detail: string } {
	const start = body.indexOf("🔒")
	if (start < 0) return { verdict: "absent", detail: "" }
	// From the emoji to the next section boundary. Scanning forward rather than
	// matching `🔒…` lazily keeps the two concerns separate: the row's own text
	// may legitimately contain an emoji, and only the FIRST `🔒` is the row.
	const rest = body.slice(start + "🔒".length)
	const end = SEC_SECTION_END.exec(rest)?.index
	const row = end === undefined ? rest : rest.slice(0, end)
	// The row, with HTML unwrapped, the emoji and `&nbsp;` gone, and the
	// HEADING removed — what remains is the model's own value for the field.
	//
	// The heading is matched as a phrase (`No security concerns identified` OR
	// `Security concerns`) rather than as a leading-run, because in the clear
	// template the verdict lives INSIDE the heading. Stripping lazily up to the
	// first "concern" would leave the trailing "identified" and then read that
	// stray word as the value.
	const detail = row
		.replace(/<[^>]*>/g, " ")
		.replace(/```[a-z]*|~~~|&nbsp;/gi, " ")
		.replace(/no security concerns identified|security concerns?/i, " ")
		.replace(/^[>\s*+-]+/gm, " ")
		.trim()
	if (SEC_NEGATION.test(detail) || detail === "") return { verdict: "clear", detail }
	// Before defaulting to `concern`: a bump review's "Yes" answers a different
	// question than a code review's, and `readsAsRemediation` is the narrow
	// reading that tells them apart. Everything it refuses stays a concern.
	if (readsAsRemediation(detail)) return { verdict: "remediated", detail }
	return { verdict: "concern", detail }
}

/**
 * The heading a ⚡ row uses when it carries the model's findings list. TWO
 * labels, both live: the renderer maps `key_issues_to_review` to "Key issues to
 * review" and `recommended_focus_areas_for_review` to "Recommended focus areas
 * for review" (markdown.ts's EMOJIS table). Both are the same field with the
 * same meaning.
 */
const ISSUES_ROW_HEADING = /key issues to review|recommended focus areas for review/i

/**
 * Read the ⚡ row's CONTENT rather than matching a phrase in it.
 *
 * WHY THIS EXISTS, and it is the same failure the `🔒` row had. When the
 * model's issue list is EMPTY, the renderer emits filler text under a heading
 * that names the field rather than the verdict:
 *
 *   <tr><td>⚡&nbsp;<strong>Key issues to review</strong><br><br>
 *
 *   No key issues identified
 *   </td></tr>
 *
 * That is a review reporting NOTHING to fix. `ISSUES_CLEAR` only recognises the
 * other rendering (`⚡ No major issues detected`, the Python's line 370), so
 * this shape fell to the `else` and scored `⚠️ Issues unclear` — a point off,
 * and an operator told the review was inconclusive when it said the opposite.
 * That is the exact line in the hub#53 ops report. Counted across the fleet on
 * 2026-10-19: 62 of the 109 PRs carrying a ⚡ findings row have this empty shape
 * (36 of those in hub and GMW alone). Same inversion as GMW#109: the verdict is
 * in the row's CONTENT, so read the content.
 *
 * @returns "clear" for an empty or negated row, "reported" when it holds items,
 *   "absent" when no ⚡ row with a findings heading is present at all.
 */
function readIssuesRow(body: string): "clear" | "reported" | "absent" {
	const start = body.indexOf("⚡")
	if (start < 0) return "absent"
	const rest = body.slice(start + "⚡".length)
	const end = SEC_SECTION_END.exec(rest)?.index
	const row = end === undefined ? rest : rest.slice(0, end)
	// No findings heading → this is some other ⚡ row (or the phrase shape),
	// which `ISSUES_CLEAR`/`ISSUES_DANGER` have already had their say on.
	if (!ISSUES_ROW_HEADING.test(row)) return "absent"
	// Unwrap the HTML and strip the heading, leaving only the model's own value
	// — the same treatment the security row gets, and for the same reason: the
	// heading names the FIELD, so leaving it in would read as content.
	const detail = row
		.replace(/<[^>]*>/g, " ")
		.replace(/```[a-z]*|~~~|&nbsp;/gi, " ")
		.replace(/key issues to review|recommended focus areas for review/gi, " ")
		.replace(/^[>\s*+-]+/gm, " ")
		.trim()
	return SEC_NEGATION.test(detail) || detail === "" ? "clear" : "reported"
}

/** Python line 370. */
const ISSUES_CLEAR = /⚡.*No major (issues|problems) detected/
/** Python line 371. */
const ISSUES_DANGER = /⚡.*(breaking change|major issue|critical|problem detected)/i
/** Python line 379 — `tests?` is greedy-optional, so "test missing" matches too. */
const TEST_MISSING = /🧪.*(Test required|tests? missing|no tests found)/i
/** Python line 380. Wins over TEST_MISSING: the bot says the tests are irrelevant. */
const TEST_IRRELEVANT = /🧪.*No relevant tests/
/** Python line 384. Lazy — see fact 3. */
const EFFORT = /⏱️.*?(\d+)/

/**
 * Python `analyze_review_safety(body)` (lines 352-391).
 *
 * Scoring is additive and order-sensitive; the early returns are what make a
 * body "unsafe" rather than merely low-scoring, so a security concern and a
 * zero-effort review are different outcomes (one blocks, the other may still
 * pass at score 6).
 */
export function analyzeReviewSafety(body: string): SafetyResult {
	if (!body) return { safe: false, reasons: ["❌ No review"], score: 0 } // line 354

	const reasons: string[] = []
	let score = BASE_SCORE

	for (const pat of ERROR_PATTERNS) {
		// Python re.search with re.IGNORECASE — a bare substring test is NOT
		// equivalent: "Traceback (most recent call last)" must match "traceback".
		if (new RegExp(pat, "i").test(body)) {
			return { safe: false, reasons: [`❌ Review error: ${pat}`], score: 0 }
		}
	}

	const sec = readSecurityRow(body)
	if (sec.verdict === "clear") {
		reasons.push("✅ Security: clean")
		score += 2
	} else if (sec.verdict === "remediated") {
		// The row described the UPDATE fixing security problems, not a finding
		// in this code. It is not evidence of a clean review — the reviewer was
		// answering a different question — so it earns the point a missing row
		// earns (none) rather than the +2 a verified-clean row earns. That keeps
		// the pass/fail boundary where it was: a bump review still has to clear
		// the ⚡ row to reach the threshold.
		reasons.push("ℹ️ Security row describes the update's security fixes, not a finding here")
	} else if (sec.verdict === "concern") {
		return { safe: false, reasons: ["🔴 Security concern — blocking"], score: 0 }
	} else {
		// No `🔒` row at all. The old code read this as "unclear" and docked a
		// point, which punished a review format that simply omits the row. There
		// is nothing to distrust, so it is neither a pass nor a penalty.
		reasons.push("⚠️ No security row in the review")
	}

	// The ⚡ row, in both of its live shapes. The findings-list heading
	// (`Key issues to review`) says nothing by itself — what it CONTAINS does —
	// so an empty or negated row reads as clear.
	//
	// CLEAR IS TESTED FIRST, and that order is load-bearing, not stylistic:
	// `ISSUES_DANGER` is case-insensitive and `major issue` is a SUBSTRING of
	// `No major issues detected`, so testing danger first blocks every clean
	// review. The row reading is ORed into the clear arm rather than given its
	// own branch, so a body with a real finding under any heading still falls to
	// `unclear` exactly as it did before — this change only rescues the empty
	// row, it does not widen what blocks.
	const issues = readIssuesRow(body)
	if (issues === "clear" || ISSUES_CLEAR.test(body)) {
		reasons.push("✅ No major issues")
		score += 2
	} else if (ISSUES_DANGER.test(body)) {
		return { safe: false, reasons: ["🔴 Major issues — blocking"], score: 0 }
	} else {
		reasons.push("⚠️ Issues unclear")
		score -= 1
	}

	// Python lines 379-382: a missing-test warning is suppressed when the body
	// ALSO says the tests are irrelevant, so a lockfile bump is not penalised
	// twice for the same section.
	const testMissing = TEST_MISSING.test(body)
	const testIrrelevant = TEST_IRRELEVANT.test(body)
	if (testMissing && !testIrrelevant) {
		reasons.push("⚠️ Tests missing")
		score -= 1
	}

	// Python lines 384-388. The `else` is not a no-op: a SMALL or absent effort
	// reading is worth +1, so the branch decides the score either way.
	const effort = EFFORT.exec(body)
	const effortRating = effort ? Number(effort[1]) : NaN
	if (effort && effortRating >= 4) {
		reasons.push(`⚠️ Large PR (effort: ${effort[1]})`)
		score -= 1
	} else {
		score += 1
	}

	// Python line 390, then line 391. Clamp BEFORE the comparison: an unclamped
	// 11 would still pass, but the clamp is what makes the reported score
	// comparable to the 0-10 scale the report and Discord messages assume.
	const clamped = Math.max(0, Math.min(10, score))
	return { safe: clamped >= SAFE_THRESHOLD, reasons, score: clamped }
}
