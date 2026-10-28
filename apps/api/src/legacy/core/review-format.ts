// The review output contract, and the correction to send when it is ignored.
//
// WHY THIS MODULE EXISTS. The review prompt ends with a worked `yaml` example
// and the sentence "The output must be a YAML object equivalent to type
// $PRReview". Two of the three configured model ids ignore that and reply in
// prose instead — measured on 2026-10-28 against the real rendered prompt
// (7,950 chars, example block included), 12 of 12 calls across
// `claude-opus-5-5` and `claude-sonnet-5-5`:
//
//   "This PR adds a single HTML comment to README.md. I can't merge, approve…"
//   "The diff is minimal and trivial — a single HTML comment added to …"
//
// None of them contained a `review:` key, so `loadYaml` parsed a string, the
// renderer saw no object, and the tool threw
// "All models failed: failed to parse review response into markdown".
//
// That failure is what hung the queue. The webhook answers 2xx before a token is
// generated, so the worker records "review requested" and waits; the review then
// dies server-side with nothing posted. Every later tick sees the stale request,
// prints "accepted, no review", and skips. No retry changes it, because the
// retry used to re-send the byte-identical prompt — and a model that had already
// answered in its own words had no reason to answer differently.
//
// THE FIX THIS SUPPORTS: tell the model what was wrong, then ask again. The
// prompt is not the problem (it already carries the schema and an example), so
// nothing is added to the system turn; the correction rides on the user turn of
// the retry only, and only when the rejection was about FORMAT. A transport
// error is retried unchanged, as before.

/** The marker the review tool's `validate` produces for an unusable body. */
const FORMAT_REJECTION = /failed to parse review response/i

/**
 * Did this rejection come from the response body, or from the call itself?
 *
 * Only a body rejection is worth correcting: a timeout, a 5xx or a dead socket
 * says nothing about format, and appending "reply in YAML" to that retry would
 * be noise. Kept narrow and explicit so the two paths stay distinguishable.
 */
export function isFormatRejection(complaint: string): boolean {
	return FORMAT_REJECTION.test(complaint)
}

/**
 * Appended to the user turn on a format retry.
 *
 * Deliberately short and imperative. It names the observed failure (prose), the
 * required shape, and the two details models most often drop — the wrapping
 * `review:` key and the absence of commentary — because those are exactly what
 * the renderer needs. It does not restate the whole schema: the system prompt
 * already contains it, and repeating 8KB would bury the correction.
 */
export const REVIEW_FORMAT_REPAIR = `Your previous reply was prose. It could not be parsed, so the review was not published.

Reply again with ONLY the YAML object — no introduction, no summary of the diff, no closing remarks, no markdown fences. Start your reply with "review:" and indent the fields beneath it, following the schema and example in the system prompt.

Required shape:

review:
  score: <0-100>
  relevant_tests: <Yes or No>
  estimated_effort_to_review_[1-5]: <1-5>
  security_concerns: <Yes or No>
  key_issues_to_review: []`
