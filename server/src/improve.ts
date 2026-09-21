// PR Code Suggestions tool (port of pr_agent.tools.pr_code_suggestions).
// Splits the PR diff into chunks, calls the LLM per chunk (parallel), merges,
// filters by score, and publishes a summarized "## PR Code Suggestions" table.

import type { Config } from "./config";
import { GitHubProvider } from "./github";
import { getPrMultiDiffs } from "./diff";
import { countPromptTokens } from "./token";
import { renderTemplate } from "./render";
import { SUGGESTIONS_SYSTEM_TEMPLATE, SUGGESTIONS_USER_TEMPLATE } from "./prompts";
import { loadYaml } from "./yaml";
import { chatCompletion } from "./llm";
import { insertBrAfterXChars } from "./describe";

export interface Suggestion {
  relevant_file: string;
  language: string;
  existing_code: string;
  suggestion_content: string;
  improved_code: string;
  one_sentence_summary: string;
  label: string;
  score?: number | string;
  score_why?: string;
  relevant_lines_start?: number | string;
  relevant_lines_end?: number | string;
}

export interface ImproveResult {
  markdown: string;
  data: { code_suggestions: Suggestion[] } | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  status: string;
}

export async function runImprove(
  cfg: Config,
  repoOwner: string,
  repoName: string,
  prNumber: number,
  privateKeyPem: string,
  opts?: {
    publish?: boolean;
    extraInstructions?: string;
    focusOnlyOnProblems?: boolean;
  },
): Promise<ImproveResult> {
  const provider = new GitHubProvider(cfg, repoOwner, repoName, prNumber, privateKeyPem);
  const pr = await provider.getPr();
  const files = await provider.getDiffFiles();
  if (!files.length) {
    return { markdown: "", data: null, model: cfg.model, promptTokens: 0, completionTokens: 0, status: "empty" };
  }

  const focus = opts?.focusOnlyOnProblems ?? true;
  const numCodeSuggestions = 3;

  const baseVars: Record<string, unknown> = {
    title: pr.title,
    date: new Date().toISOString().slice(0, 10),
    diff_no_line_numbers: "",
    focus_only_on_problems: focus,
    num_code_suggestions: numCodeSuggestions,
    is_ai_metadata: false,
    skills_context: "",
    extra_instructions: opts?.extraInstructions ?? "",
    repo_context: "",
    duplicate_prompt_examples: false,
  };

  const promptTokens = countPromptTokens(
    SUGGESTIONS_SYSTEM_TEMPLATE,
    SUGGESTIONS_USER_TEMPLATE,
    baseVars,
    renderTemplate,
  );

  const { chunks, chunksNoLineNumbers } = getPrMultiDiffs(
    files,
    promptTokens,
    cfg.model,
    cfg,
    3,
    true,
  );

  // parallel LLM calls per chunk (max 3)
  const models = [cfg.model, ...cfg.fallbackModels];
  const preds: Suggestion[][] = [];
  let usedModel = cfg.model;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let lastErr: unknown = null;

  const callChunk = async (chunk: string, chunkNoLn: string, model: string): Promise<void> => {
    const vars = { ...baseVars, diff_no_line_numbers: chunkNoLn };
    const system = renderTemplate(SUGGESTIONS_SYSTEM_TEMPLATE, vars);
    const user = renderTemplate(SUGGESTIONS_USER_TEMPLATE, vars);
    const res = await chatCompletion({ model, system, user, temperature: cfg.temperature, cfg });
    totalPrompt += res.usage?.promptTokens ?? 0;
    totalCompletion += res.usage?.completionTokens ?? 0;
    const data = loadYaml(
      res.content.replace(/^```yaml\s*/i, "").replace(/```\s*$/i, "").trim(),
      ["code_suggestions:", "relevant_file:", "suggestion_content:", "improved_code:", "one_sentence_summary:", "label:", "score:"],
    ) as { code_suggestions?: unknown[] } | null;
    if (data && Array.isArray(data.code_suggestions)) {
      preds.push(data.code_suggestions as Suggestion[]);
    }
  };

  const attemptOneModel = async (model: string): Promise<boolean> => {
    preds.length = 0;
    totalPrompt = 0;
    totalCompletion = 0;
    try {
      await Promise.all(chunks.map((c, i) => callChunk(c, chunksNoLineNumbers[i] ?? c, model)));
      usedModel = model;
      return true;
    } catch (e) {
      lastErr = e;
      return false;
    }
  };

  let ok = false;
  for (const model of models) {
    if (await attemptOneModel(model)) { ok = true; break; }
  }
  if (!ok) {
    throw new Error(`All models failed: ${(lastErr as Error)?.message ?? "unknown"}`);
  }

  // merge + filter by score threshold (default 0 → keep all)
  const threshold = 0;
  const all: Suggestion[] = [];
  for (const list of preds) {
    for (const s of list) {
      const score = s.score !== undefined ? Number(s.score) : 1;
      if (score >= threshold) all.push({ ...s, score });
    }
  }

  const data = { code_suggestions: all };
  const markdown = all.length
    ? await generateSummariasedSuggestions(all, provider)
    : "## PR Code Suggestions ✨\n\nNo suggestions found to improve this PR.";

  if (opts?.publish !== false) {
    if (all.length) {
      await provider.publishPersistentComment(
        markdown,
        "## PR Code Suggestions ✨",
        "suggestions",
        false,
      );
    } else {
      await provider.publishComment(markdown);
    }
  }

  return {
    markdown,
    data,
    model: usedModel,
    promptTokens: totalPrompt || promptTokens,
    completionTokens: totalCompletion,
    status: "success",
  };
}

async function generateSummariasedSuggestions(
  suggestions: Suggestion[],
  provider: GitHubProvider,
): Promise<string> {
  let prBody = "## PR Code Suggestions ✨\n\n";

  // group by label, sort groups by max score desc, sort inside by score desc
  const groups: Record<string, Suggestion[]> = {};
  for (const s of suggestions) {
    const label = s.label.trim().replace(/^['"]|['"]$/g, "");
    (groups[label] ??= []).push(s);
  }
  const sortedLabels = Object.keys(groups).sort(
    (a, b) => Math.max(...groups[b].map((s) => Number(s.score ?? 0))) - Math.max(...groups[a].map((s) => Number(s.score ?? 0))),
  );

  prBody += "<table>";
  prBody += `<thead><tr><td><strong>Category</strong></td><td align=left><strong>Suggestion&nbsp; </strong></td><td align=center><strong>Impact</strong></td></tr>`;
  prBody += "<tbody>";
  for (const label of sortedLabels) {
    const list = [...groups[label]].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
    prBody += `<tr><td rowspan=${list.length}>${label.charAt(0).toUpperCase() + label.slice(1)}</td>\n`;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const file = s.relevant_file.trim();
      const start = Math.max(1, Number(s.relevant_lines_start ?? 1));
      const end = Math.max(start, Number(s.relevant_lines_end ?? start));
      const rangeStr = start === end ? `[${start}]` : `[${start}-${end}]`;
      let link = "";
      try {
        const startNum = Math.max(1, Number(s.relevant_lines_start ?? 1));
        const endNum = Math.max(startNum, Number(s.relevant_lines_end ?? startNum));
        const raw = await provider.getLineLink(file, startNum, endNum > startNum ? endNum : undefined);
        link = raw;
      } catch {
        link = "";
      }
      const content = insertBrAfterXChars(s.suggestion_content.replace(/\n$/, ""), 84);
      const existing = s.existing_code.replace(/\n$/, "") + "\n";
      const improved = s.improved_code.replace(/\n$/, "") + "\n";
      const patch = unifiedDiff(existing, improved);
      let summary = s.one_sentence_summary.trim().replace(/\.$/, "");
      if (/(?:^|['"])<.*>(?:['"]|$)/.test(summary)) {
        summary = summary.replace(/'</g, "`<").replace(/>'/g, ">`");
      }
      prBody += i === 0 ? `<td>\n\n` : `<tr><td>\n\n`;
      prBody += `\n\n<details><summary>${summary}</summary>\n\n___\n\n`;
      prBody += `**${content}**\n\n[${file} ${rangeStr}](${link})\n\n${patch}\n`;
      if (s.score_why) {
        const scoreInt = Number(s.score ?? 0);
        prBody += `<details><summary>Suggestion importance[1-10]: ${scoreInt}</summary>\n\n__\n\nWhy: ${s.score_why}\n\n</details>`;
      }
      prBody += `</details>`;
      prBody += `</td><td align=center>${scoreStr(Number(s.score ?? 0))}\n\n`;
      prBody += `</td></tr>`;
    }
  }
  prBody += `</tr></tbody></table>`;
  return prBody;
}

function scoreStr(score: number): string {
  if (score >= 9) return "High";
  if (score >= 7) return "Medium";
  return "Low";
}

/** Minimal unified diff of two snippets (mirrors difflib.unified_diff with
 *  n=999 so the whole snippet is one hunk). */
function unifiedDiff(existing: string, improved: string): string {
  const lines = (s: string) => s.split("\n");
  const oldLines = lines(existing);
  const newLines = lines(improved);
  // drop trailing empty string artifacts
  if (oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (newLines[newLines.length - 1] === "") newLines.pop();

  const out: string[] = [];
  // find common prefix/suffix
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const start = prefix + 1;
  out.push("```diff");
  out.push(`@@ -${start},${oldMid.length} +${start},${newMid.length} @@`);
  for (const l of oldMid) out.push("-" + l);
  for (const l of newMid) out.push("+" + l);
  out.push("```");
  return out.join("\n");
}