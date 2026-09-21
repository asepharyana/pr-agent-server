// Token counting — port of pr_agent.algo.token_handler using js-tiktoken
// (o200k_base, same as Python tiktoken). The Python version tried an accurate
// Anthropic count_tokens API call when anthropic.key was set; with 9router that
// call is not an Anthropic API, so we always use the local tokenizer estimate
// (which is what the Python server effectively falls back to on failure).

import { getEncoding, type Tiktoken } from "js-tiktoken";

let _encoder: Tiktoken | null = null;

export function getTokenEncoder(): Tiktoken {
  if (!_encoder) {
    try {
      _encoder = getEncoding("o200k_base");
    } catch {
      // cl100k_base as a safe fallback if o200k unavailable on old bundles
      _encoder = getEncoding("cl100k_base");
    }
  }
  return _encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return getTokenEncoder().encode(text, "all").length;
  } catch {
    // approximate: ~4 chars/token
    return Math.ceil(text.length / 4);
  }
}

/**
 * Approximation of pr_agent's TokenHandler.prompt_tokens: renders the system
 * and user prompt strings with the given vars (nunjucks), then counts tokens.
 */
export function countPromptTokens(
  systemTemplate: string,
  userTemplate: string,
  vars: Record<string, unknown>,
  render: (tmpl: string, data: Record<string, unknown>) => string,
): number {
  try {
    const system = render(systemTemplate, vars);
    const user = render(userTemplate, vars);
    return countTokens(system) + countTokens(user);
  } catch {
    return 0;
  }
}