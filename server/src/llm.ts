// LLM handler — 9router via OpenAI-compatible /chat/completions.
// Reflects pr_agent's LiteLLMAIHandler behavior for claude-opus-5:
//   - messages = [{system},{user}]
//   - temperature OMITTED for models in NO_SUPPORT_TEMPERATURE_MODELS
//     (claude-opus-5, claude-sonnet-5 are in that list)
//   - timeout = ai_timeout (600s)
//   - non-streaming (claude-opus-5 not in STREAMING_REQUIRED_MODELS)
//   - raises on empty content
// Returns { content, finishReason, usage }.

import type { Config } from "./config";

export interface ChatResult {
  content: string;
  finishReason: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
  };
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
  "o1", "o1-mini", "o1-preview", "o3", "o3-mini", "o4-mini",
  "gpt-5.1-codex", "gpt-5.2-codex", "gpt-5-mini",
  "deepseek/deepseek-reasoner",
]);

export async function chatCompletion(
  opts: {
    model: string;
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    cfg: Config;
    signal?: AbortSignal;
  },
): Promise<ChatResult> {
  const { model, system, user, temperature, cfg } = opts;
  const messages: Record<string, string>[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };
  // temperature omitted for models that don't support it (incl. claude-opus-5)
  const isNoTemp = NO_SUPPORT_TEMPERATURE_MODELS.has(model);
  if (temperature !== undefined && !isNoTemp) {
    body["temperature"] = temperature;
  }
  if (opts.maxTokens) body["max_tokens"] = opts.maxTokens;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    cfg.aiTimeoutMs || 600000,
  );
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
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
    });

    if (!resp.ok) {
      let detail = "";
      try {
        const errJson = (await resp.json()) as { error?: { message?: string } };
        detail = errJson.error?.message || "";
      } catch {
        detail = await resp.text();
      }
      throw new Error(
        `LLM request failed (${resp.status}): ${detail || resp.statusText}`,
      );
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    if (!content) {
      throw new Error(
        `Empty content in model response (finish_reason: ${choice?.finish_reason ?? "?"})`,
      );
    }
    return {
      content,
      finishReason: choice?.finish_reason ?? "stop",
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
            cachedTokens: data.usage.prompt_tokens_details?.cached_tokens,
          }
        : undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}