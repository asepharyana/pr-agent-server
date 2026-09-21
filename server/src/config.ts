// Config for the Bun PR-Agent re-implementation.
// Mirrors pr_agent settings/configuration.toml defaults that matter to the
// review pipeline, with env-var overrides (same names as the Python server used,
// minus the Dynaconf prefix dance — we read plain env vars).

import { readFileSync } from "node:fs";

export interface Config {
  // model routing
  model: string;
  fallbackModels: string[];
  maxModelTokens: number; // capping for get_max_tokens (config.max_model_tokens)
  customModelMaxTokens: number; // used when a model is not in the MAX_TOKENS table
  aiTimeoutMs: number;
  temperature: number;
  // review features
  prReviewer: {
    requireScoreReview: boolean;
    requireTestsReview: boolean;
    requireEstimateEffortToReview: boolean;
    requireSecurityReview: boolean;
    requireCanBeSplitReview: boolean;
    requireEstimateContributionTimeCost: boolean;
    requireTodoScan: boolean;
    numMaxFindings: number;
    persistentComment: boolean;
    inlineKeyIssues: boolean;
    publishOutputNoSuggestions: boolean;
    enableHelpText: boolean;
    enableReviewCoverageFooter: boolean;
    enableIntroText: boolean;
    extraInstructions: string;
    finalUpdateMessage: boolean;
  };
  // pr_description — needed when reusing the description pipeline later
  prDescription: {
    maxAiCalls: number;
    enableLargePrHandling: boolean;
    enablePrType: boolean;
    enablePrDescription: boolean;
    enablePrDiagram: boolean;
    publishDescriptionAsComment: boolean;
    publishLabels: boolean;
    finalUpdateMessage: boolean;
  };
  // git/diff
  patchExtraLinesBefore: number;
  patchExtraLinesAfter: number;
  patchExtensionSkipTypes: string[];
  allowDynamicContext: boolean;
  maxExtraLinesBeforeDynamicContext: number;
  maxDescriptionTokens: number;
  maxCommitsTokens: number;
  outputBufferSoftThreshold: number;
  outputBufferHardThreshold: number;
  // github
  github: {
    baseUrl: string; // api.github.com
    deploymentType: string; // "app"
    appId: string;
    publishAsCheckRun: boolean;
    rateLimitRetries: number;
    rateLimitDelaySec: number;
  };
  // llm
  llm: {
    baseUrl: string;
    apiKey: string;
    extraHeaders: Record<string, string>;
  };
}

const env = process.env;

function envInt(name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(): Config {
  const model = env.PR_AGENT_MODEL || "claude-opus-5";
  let fallbackModels: string[] = ["claude-sonnet-5", "claude-haiku-4-5-20251001"];
  if (env.PR_AGENT_FALLBACK_MODELS) {
    try {
      fallbackModels = JSON.parse(env.PR_AGENT_FALLBACK_MODELS);
    } catch {
      fallbackModels = env.PR_AGENT_FALLBACK_MODELS.split(",").map((s) => s.trim());
    }
  }

  // Key resolution: the Python server used ANTHROPIC_API_KEY = omni key for
  // 9router. Prefer OMNIROUTE_API_KEY (verified live), fall back to
  // ANTHROPIC_API_KEY then OPENAI_API_KEY, then the on-disk omni key file
  // (same source of truth as run_server.py: /var/lib/pr-agent-server/omniroute_key).
  const appDir = env.PR_AGENT_APP_DIR || "/var/lib/pr-agent-server";
  let fileKey = "";
  try {
    fileKey = readFileSync(`${appDir}/omniroute_key`, "utf8").trim();
  } catch {
    // fall through
  }
  const apiKey =
    env.OMNIROUTE_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    env.OPENAI_API_KEY ||
    fileKey ||
    "";
  const baseUrl =
    env.OPENAI_API_BASE || "https://9router.asepharyana.my.id/v1";

  return {
    model,
    fallbackModels,
    maxModelTokens: envInt("PR_AGENT_MAX_MODEL_TOKENS", 128000),
    customModelMaxTokens: envInt("PR_AGENT_CUSTOM_MODEL_MAX_TOKENS", 128000),
    aiTimeoutMs: envInt("PR_AGENT_AI_TIMEOUT", 600) * 1000,
    temperature: envInt("PR_AGENT_TEMPERATURE", 20) / 100,
    prReviewer: {
      requireScoreReview: (env.PR_AGENT_REQUIRE_SCORE || "true").toLowerCase() === "true",
      requireTestsReview: (env.PR_AGENT_REQUIRE_TESTS || "true").toLowerCase() === "true",
      requireEstimateEffortToReview:
        (env.PR_AGENT_REQUIRE_EFFORT || "true").toLowerCase() === "true",
      requireSecurityReview:
        (env.PR_AGENT_REQUIRE_SECURITY || "true").toLowerCase() === "true",
      requireCanBeSplitReview:
        (env.PR_AGENT_REQUIRE_SPLIT || "false").toLowerCase() === "true",
      requireEstimateContributionTimeCost:
        (env.PR_AGENT_REQUIRE_TIME_COST || "false").toLowerCase() === "true",
      requireTodoScan: (env.PR_AGENT_REQUIRE_TODO || "false").toLowerCase() === "true",
      numMaxFindings: envInt("PR_AGENT_MAX_FINDINGS", 3),
      persistentComment:
        (env.PR_AGENT_PERSISTENT_COMMENT ?? "true").toLowerCase() === "true",
      inlineKeyIssues:
        (env.PR_AGENT_INLINE_KEY_ISSUES || "false").toLowerCase() === "true",
      publishOutputNoSuggestions:
        (env.PR_AGENT_PUBLISH_NO_SUGGESTIONS ?? "true").toLowerCase() === "true",
      enableHelpText: (env.PR_AGENT_ENABLE_HELP_TEXT || "false").toLowerCase() === "true",
      enableReviewCoverageFooter:
        (env.PR_AGENT_ENABLE_COVERAGE_FOOTER ?? "true").toLowerCase() === "true",
      enableIntroText: (env.PR_AGENT_ENABLE_INTRO ?? "true").toLowerCase() === "true",
      extraInstructions: env.PR_AGENT_EXTRA_INSTRUCTIONS || "",
      finalUpdateMessage: (env.PR_AGENT_FINAL_UPDATE ?? "true").toLowerCase() === "true",
    },
    prDescription: {
      maxAiCalls: envInt("PR_AGENT_MAX_AI_CALLS", 4),
      enableLargePrHandling:
        (env.PR_AGENT_LARGE_PR_HANDLING ?? "true").toLowerCase() === "true",
      enablePrType: (env.PR_AGENT_DESC_ENABLE_TYPE ?? "true").toLowerCase() === "true",
      enablePrDescription:
        (env.PR_AGENT_DESC_ENABLE_DESCRIPTION ?? "true").toLowerCase() === "true",
      enablePrDiagram:
        (env.PR_AGENT_DESC_ENABLE_DIAGRAM ?? "true").toLowerCase() === "true",
      publishDescriptionAsComment:
        (env.PR_AGENT_DESC_PUBLISH_AS_COMMENT ?? "false").toLowerCase() === "true",
      publishLabels:
        (env.PR_AGENT_DESC_PUBLISH_LABELS ?? "false").toLowerCase() === "true",
      finalUpdateMessage:
        (env.PR_AGENT_DESC_FINAL_UPDATE ?? "true").toLowerCase() === "true",
    },
    patchExtraLinesBefore: envInt("PR_AGENT_PATCH_EXTRA_BEFORE", 5),
    patchExtraLinesAfter: envInt("PR_AGENT_PATCH_EXTRA_AFTER", 1),
    patchExtensionSkipTypes: [".md", ".txt"],
    allowDynamicContext: (env.PR_AGENT_DYNAMIC_CONTEXT ?? "true").toLowerCase() === "true",
    maxExtraLinesBeforeDynamicContext: envInt("PR_AGENT_MAX_DYNAMIC_CONTEXT", 10),
    maxDescriptionTokens: envInt("PR_AGENT_MAX_DESCRIPTION_TOKENS", 500),
    maxCommitsTokens: envInt("PR_AGENT_MAX_COMMITS_TOKENS", 500),
    outputBufferSoftThreshold: envInt("PR_AGENT_OUTPUT_SOFT", 1500),
    outputBufferHardThreshold: envInt("PR_AGENT_OUTPUT_HARD", 1000),
    github: {
      baseUrl: env.GITHUB_API_BASE || "https://api.github.com",
      deploymentType: env.GITHUB__DEPLOYMENT_TYPE || "app",
      appId: env.GITHUB_APP_ID || "4319749",
      publishAsCheckRun:
        (env.PR_AGENT_PUBLISH_CHECK_RUN || "false").toLowerCase() === "true",
      rateLimitRetries: envInt("PR_AGENT_RATE_LIMIT_RETRIES", 5),
      rateLimitDelaySec: envInt("PR_AGENT_RATE_LIMIT_DELAY", 2),
    },
    llm: {
      baseUrl,
      apiKey,
      extraHeaders: {},
    },
  };
}

export function getModelTokenLimit(model: string, cfg?: Config): number {
  const c = cfg ?? loadConfig();
  const table: Record<string, number> = {
    "claude-opus-5": 1000000,
    "anthropic/claude-opus-5": 1000000,
    "claude-sonnet-5": 1000000,
    "anthropic/claude-sonnet-5": 1000000,
    "claude-haiku-4-5-20251001": 200000,
    "anthropic/claude-haiku-4-5-20251001": 200000,
    "gpt-5": 200000,
    "gpt-5.6": 1050000,
    // fallback for unknown models
  };
  let limit = table[model];
  if (limit === undefined) {
    limit = c.customModelMaxTokens > 0 ? c.customModelMaxTokens : 128000;
  }
  if (c.maxModelTokens > 0) limit = Math.min(c.maxModelTokens, limit);
  return limit;
}