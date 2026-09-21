// PR Review tool — orchestrates the whole review: fetch PR, build diff,
// render prompts, call LLM, parse YAML, render markdown, publish.
// Port of pr_agent.tools.pr_reviewer.

import type { Config } from "./config";
import { GitHubProvider } from "./github";
import { getPrDiff, sortFilesByMainLanguages } from "./diff";
import { countTokens } from "./token";
import { countPromptTokens } from "./token";
import { renderTemplate } from "./render";
import { REVIEW_SYSTEM_TEMPLATE, REVIEW_USER_TEMPLATE } from "./prompts";
import { loadYaml } from "./yaml";
import { convertToMarkdownV2 } from "./markdown";
import { chatCompletion } from "./llm";
import { getModelTokenLimit as getModelTokenLimitInner } from "./config";

export interface ReviewResult {
  markdown: string;
  data: Record<string, unknown> | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  remainingFiles: string[];
  diff: string;
  status: string;
}

export async function runReview(
  cfg: Config,
  repoOwner: string,
  repoName: string,
  prNumber: number,
  privateKeyPem: string,
  opts?: {
    publish?: boolean;
    extraInstructions?: string;
  },
): Promise<ReviewResult> {
  const provider = new GitHubProvider(cfg, repoOwner, repoName, prNumber, privateKeyPem);
  const pr = await provider.getPr();
  const files = await provider.getDiffFiles();

  // main language
  let languages: Record<string, number> = {};
  try {
    languages = await provider.getLanguages();
  } catch {
    languages = {};
  }
  const mainLanguage = getMainPrLanguage(languages, files);

  const description = await provider.getPrDescription(true);
  const branch = await provider.getPrBranch();
  const commitMessagesStrRaw = await provider.getCommitMessagesStr(cfg.maxCommitsTokens);
  const commitMessagesStr = clipTokensSimple(commitMessagesStrRaw, cfg.maxCommitsTokens);
  const title = pr.title;
  const date = new Date().toISOString().slice(0, 10);

  const r = cfg.prReviewer;
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
  };

  // prompt tokens
  const promptTokens = countPromptTokens(
    REVIEW_SYSTEM_TEMPLATE,
    REVIEW_USER_TEMPLATE,
    vars,
    renderTemplate,
  );

  // build diff with token budget (reuses prompt tokens)
  const { diff, remainingFiles } = getPrDiffWithFiles(files, promptTokens, cfg.model, cfg, vars);

  // render final prompts with diff
  const systemPrompt = renderTemplate(REVIEW_SYSTEM_TEMPLATE, { ...vars, diff });
  const userPrompt = renderTemplate(REVIEW_USER_TEMPLATE, { ...vars, diff });

  // LLM call with fallback models
  const models = [cfg.model, ...cfg.fallbackModels];
  let content = "";
  let finishReason = "";
  let usedModel = cfg.model;
  let usage: { promptTokens: number; completionTokens: number; cachedTokens: number } = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  };

  let lastErr: unknown = null;
  for (const model of models) {
    try {
      const res = await chatCompletion({
        model,
        system: systemPrompt,
        user: userPrompt,
        temperature: cfg.temperature,
        cfg,
      });
      content = res.content;
      finishReason = res.finishReason;
      usedModel = model;
      usage = {
        promptTokens: res.usage?.promptTokens ?? 0,
        completionTokens: res.usage?.completionTokens ?? 0,
        cachedTokens: res.usage?.cachedTokens ?? 0,
      };
      break;
    } catch (e) {
      lastErr = e;
      // if all models fail, throw; else try next
    }
  }
  if (!content) {
    throw new Error(`All models failed: ${(lastErr as Error)?.message ?? "unknown"}`);
  }

  // parse YAML (resilient)
  const keysFix = [
    "ticket_compliance_check",
    "estimated_effort_to_review_[1-5]:",
    "security_concerns:",
    "key_issues_to_review:",
    "relevant_file:",
    "relevant_line:",
    "suggestion:",
  ];
  let data = loadYaml(content, keysFix, "review", "security_concerns") as Record<string, unknown> | null;
  // loadYaml returns { review: ... } — keep as is
  if (data && !("review" in data) && "review" in (data as object)) {
    data = { review: (data as { review: unknown }).review };
  }

  // render markdown
  const markdown = data && "review" in data
    ? convertToMarkdownV2(data as { review: Record<string, unknown> }, true, r.enableIntroText)
    : "";

  // publish
  if (opts?.publish !== false) {
    if (markdown) {
      // persistent comment (replace prev "## PR Reviewer Guide 🔍")
      if (r.persistentComment) {
        await provider.publishPersistentComment(markdown, "## PR Reviewer Guide 🔍", "review", r.finalUpdateMessage);
      } else {
        await provider.publishComment(markdown);
      }
    }
  }

  return {
    markdown,
    data,
    model: usedModel,
    promptTokens: usage.promptTokens || promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    remainingFiles,
    diff,
    status: "success",
  };
}

function getPrDiffWithFiles(
  files: Parameters<typeof getPrDiff>[0],
  promptTokens: number,
  model: string,
  cfg: Config,
  vars: Record<string, unknown>,
): { diff: string; remainingFiles: string[] } {
  // Sort by main language first (pushes main-lang files earlier, matching
  // pr_agent's pr_generate_extended_diff order; we use the files order as-is
  // since the Python version sorts by lang then processes all files equally).
  const langs = (vars["_langs"] as Record<string, number>) || {};
  const sorted = sortFilesByMainLanguages(langs, files);
  // Reuse getPrDiff with our token budget logic
  const res = getPrDiff(sorted, promptTokens, model, cfg);
  return { diff: res.diff, remainingFiles: res.remainingFiles };
}

function clipTokensSimple(text: string, maxTokens: number): string {
  const tokens = countTokens(text);
  if (tokens <= maxTokens) return text;
  // approximate chars/token from actual ratio
  const ratio = text.length / Math.max(1, tokens);
  const target = Math.floor(maxTokens * ratio * 0.9);
  return text.slice(0, target) + "\n...(truncated)";
}

function getMainPrLanguage(
  languages: Record<string, number>,
  files: { filename: string }[],
): string {
  if (!languages || Object.keys(languages).length === 0 || !files.length) return "";
  const top = Object.entries(languages).sort((a, b) => b[1] - a[1])[0][0].toLowerCase();
  const ext = files[0].filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    python: "Python", typescript: "TypeScript", javascript: "JavaScript",
    go: "Go", rust: "Rust", java: "Java", csharp: "C#", cpp: "C++", ruby: "Ruby",
    php: "PHP", swift: "Swift", kotlin: "Kotlin", shell: "Shell", html: "HTML",
    css: "CSS", vue: "Vue", scala: "Scala",
  };
  const extLang: Record<string, string> = {
    py: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    go: "go", rs: "rust", java: "java", cs: "csharp", cpp: "cpp", rb: "ruby",
    php: "php", swift: "swift", kt: "kotlin", sh: "shell", bash: "shell",
    html: "html", css: "css", vue: "vue", scala: "scala",
  };
  const langOfExt = extLang[ext] || "";
  if (langOfExt && langOfExt === top) return map[top] || top;
  return langOfExt ? map[langOfExt] || langOfExt : (map[top] || top);
}

export function getModelTokenLimitLocal(model: string, cfg: Config): number {
  return getModelTokenLimitInner(model, cfg);
}