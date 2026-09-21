// PR Description tool (port of pr_agent.tools.pr_description).
// Generates a full PR description: type, title, description, diagram and
// per-file walkthrough from the AI prediction, then publishes it.

import type { Config } from "./config";
import { GitHubProvider } from "./github";
import { getPrDiff } from "./diff";
import { countPromptTokens } from "./token";
import { renderTemplate } from "./render";
import { DESCRIPTION_SYSTEM_TEMPLATE, DESCRIPTION_USER_TEMPLATE } from "./prompts";
import { loadYaml } from "./yaml";
import { chatCompletion } from "./llm";

export interface DescribeResult {
  markdown: string;
  data: Record<string, unknown> | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  status: string;
}

interface FileLabelEntry {
  filename: string;
  changesTitle: string;
  changesSummary: string;
}

const COLLAPSIBLE_FILE_LIST_THRESHOLD = 6;

const TYPES_ENUM = ["Bug fix", "Tests", "Enhancement", "Documentation", "Other"];

export async function runDescribe(
  cfg: Config,
  repoOwner: string,
  repoName: string,
  prNumber: number,
  privateKeyPem: string,
  opts?: {
    publish?: boolean;
    extraInstructions?: string;
    publishLabels?: boolean;
    generateAiTitle?: boolean;
  },
): Promise<DescribeResult> {
  const provider = new GitHubProvider(cfg, repoOwner, repoName, prNumber, privateKeyPem);
  const pr = await provider.getPr();
  const files = await provider.getDiffFiles();

  const title = pr.title;
  const description = await provider.getPrDescription(true);
  const branch = await provider.getPrBranch();
  const commitMessagesStr = await provider.getCommitMessagesStr(cfg.maxCommitsTokens);

  const descCfg = cfg.prDescription;

  const baseVars: Record<string, unknown> = {
    title,
    branch,
    description,
    diff: "",
    commit_messages_str: commitMessagesStr,
    skills_context: "",
    extra_instructions: opts?.extraInstructions ?? "",
    repo_context: "",
    enable_custom_labels: false,
    custom_labels_class: "",
    enable_semantic_files_types: true,
    include_file_summary_changes: true,
    enable_pr_type: true,
    enable_pr_description: true,
    enable_pr_diagram: true,
    duplicate_prompt_examples: false,
    related_tickets: [],
    is_ai_metadata: false,
  };

  // Build diff with token budget (reuse review pipeline logic)
  const promptTokens = countPromptTokens(
    DESCRIPTION_SYSTEM_TEMPLATE,
    DESCRIPTION_USER_TEMPLATE,
    baseVars,
    renderTemplate,
  );
  const { diff, remainingFiles } = getPrDiff(files, promptTokens, cfg.model, cfg);

  const vars = { ...baseVars, diff };
  const systemPrompt = renderTemplate(DESCRIPTION_SYSTEM_TEMPLATE, vars);
  const userPrompt = renderTemplate(DESCRIPTION_USER_TEMPLATE, vars);

  // LLM call with fallback models
  const models = [cfg.model, ...cfg.fallbackModels];
  let content = "";
  let usedModel = cfg.model;
  let usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
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
      usedModel = model;
      usage = {
        promptTokens: res.usage?.promptTokens ?? 0,
        completionTokens: res.usage?.completionTokens ?? 0,
        cachedTokens: res.usage?.cachedTokens ?? 0,
      };
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!content) {
    throw new Error(`All models failed: ${(lastErr as Error)?.message ?? "unknown"}`);
  }

  // Parse prediction YAML
  let prediction = content.replace(/^```yaml\s*/i, "").replace(/```\s*$/i, "").trim().replace(/^```/i, "");
  const keysFix = [
    "pr_files:",
    "changes_summary:",
    "changes_title:",
    "label:",
    "changes_diagram:",
    "description:",
    "type:",
  ];
  const data = loadYaml(prediction, keysFix) as Record<string, unknown> | null;
  if (!data) {
    throw new Error("Failed to parse description YAML");
  }

  // Sanitize + reorder data (mirrors _prepare_data)
  const ordered: Record<string, unknown> = {};
  if (typeof data["User Description"] === "string") ordered["User Description"] = data["User Description"];
  if (data["type"] !== undefined) ordered["type"] = data["type"];
  if (data["labels"] !== undefined) ordered["labels"] = data["labels"];
  if (data["description"] !== undefined) ordered["description"] = data["description"];
  if (data["changes_diagram"] !== undefined) {
    const sanitized = sanitizeDiagram(String(data["changes_diagram"]));
    if (sanitized) {
      ordered["changes_diagram"] = applyDiagramDirection(sanitized, "adaptive", 5);
    }
  }
  if (data["pr_files"] !== undefined) ordered["pr_files"] = data["pr_files"];
  for (const k of Object.keys(data)) {
    if (!(k in ordered)) ordered[k] = data[k];
  }

  // File labels grouping (mirrors _prepare_file_labels)
  const fileLabelDict: Record<string, FileLabelEntry[]> = {};
  const prFiles = (ordered["pr_files"] as unknown[]) ?? [];
  for (const f of prFiles as Record<string, unknown>[]) {
    const req = ["changes_title", "filename", "label"];
    if (!req.every((r) => f[r] !== undefined && f[r] !== "")) {
      continue;
    }
    const filename = String(f["filename"]).replace(/'/g, "`");
    const changesSummary = String(f["changes_summary"] ?? "").trim();
    const changesTitle = String(f["changes_title"]).trim();
    const label = String(f["label"]).trim().toLowerCase();
    if (!changesSummary) continue;
    if (!fileLabelDict[label]) fileLabelDict[label] = [];
    fileLabelDict[label].push({ filename, changesTitle, changesSummary });
  }

  // Build PR body (mirrors _prepare_pr_answer)
  const aiTitle = String(ordered["title"] ?? title).trim();
  const publishTitle = opts?.generateAiTitle ? aiTitle : title;
  const cleanup = { ...ordered };
  delete cleanup["labels"];
  delete cleanup["title"];
  if (!descCfg.enablePrType) delete cleanup["type"];
  if (descCfg.enablePrDescription === false) delete cleanup["description"];

  let prBody = "";
  const entries = Object.entries(cleanup);
  for (let idx = 0; idx < entries.length; idx++) {
    const [key, value] = entries[idx];
    const keyPublish = key.replace(/:$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    const header = keyPublish === "Type" ? "PR Type" : keyPublish;
    prBody += `### **${header}**\n`;
    if (key === "changes_diagram") {
      prBody += `${value}\n`;
    } else if (key === "pr_files") {
      // walkthrough table appended separately below
    } else if (key === "description") {
      const v = Array.isArray(value) ? value.map((x) => String(x).replace(/\s+$/, "")).join(", ") : String(value);
      prBody += `${v.replace(/\n-/g, "\n\n-").trim()}\n`;
    } else {
      const v = Array.isArray(value) ? value.map((x) => String(x).replace(/\s+$/, "")).join(", ") : String(value);
      prBody += `${v}\n`;
    }
    if (idx < entries.length - 1) prBody += "\n\n___\n\n";
  }

  // File walkthrough table
  const table = processPrFilesPrediction(fileLabelDict, files, provider);
  prBody += `\n\n<details> <summary><h3> File walkthrough</h3></summary>\n\n${table}\n\n</details>\n\n`;

  // Help text (matches pr_agent when enable_help_comment)
  prBody += `\n\n___\n\n> <details> <summary>  Need help?</summary><li>Type <code>/help how to ...</code> `
    + `in the comments thread for any questions about PR-Agent usage.</li><li>Check out the `
    + `<a href="https://qodo-merge-docs.qodo.ai/usage-guide/">documentation</a> `
    + `for more information.</li></details>`;

  const markdown = `## Title\n\n${publishTitle}\n\n___\n${prBody}`;

  // Publish
  if (opts?.publish !== false) {
    if (descCfg.publishDescriptionAsComment) {
      await provider.publishPersistentComment(
        `## Title\n\n${publishTitle}\n\n___\n${prBody}`,
        "## Title",
        "describe",
        descCfg.finalUpdateMessage,
      );
    } else {
      await provider.updateDescription(publishTitle, prBody);
      if (descCfg.finalUpdateMessage) {
        const latestCommit = await provider.getLatestCommitUrl();
        const prUrl = pr.htmlUrl;
        await provider.publishComment(
          `**[PR Description](${prUrl})** updated to latest commit (${latestCommit})`,
        );
      }
    }
    // labels
    if (opts?.publishLabels) {
      const labels = deriveLabels(ordered);
      const existing = await provider.getLabels();
      const userLabels = existing.filter((l) => !TYPES_ENUM.includes(l));
      const newLabels = [...labels, ...userLabels];
      const needUpdate = newLabels.length !== existing.length ||
        newLabels.some((l) => !existing.includes(l));
      if (needUpdate && newLabels.length > 0) {
        await provider.addLabels(newLabels);
      }
    }
  }

  return {
    markdown,
    data: ordered,
    model: usedModel,
    promptTokens: usage.promptTokens || promptTokens,
    completionTokens: usage.completionTokens,
    status: "success",
  };
}

export function deriveLabels(data: Record<string, unknown>): string[] {
  const raw = data["labels"] ?? data["type"];
  let labels: string[] = [];
  if (Array.isArray(raw)) labels = raw.map((x) => String(x));
  else if (typeof raw === "string") labels = raw.split(",").map((s) => s.trim());
  return labels.filter(Boolean);
}

export function sanitizeDiagram(diagramRaw: string): string {
  // strip stray fences and empty diagrams
  let d = diagramRaw.trim();
  d = d.replace(/^```mermaid\s*/i, "").replace(/```\s*$/, "").trim();
  if (!d || !/flowchart|graph\s+[A-Za-z]/.test(d)) return "";
  return d;
}

function applyDiagramDirection(diagram: string, _direction: string, threshold: number): string {
  // adaptive: if the longest node chain exceeds threshold, switch to TD
  const lines = diagram.split("\n");
  const edges = lines
    .map((l) => l.trim())
    .filter((l) => l.includes("-->") || l.includes("---"))
    .map((l) => {
      const m = l.match(/^([A-Za-z0-9_]+)\s*--.*-->\s*([A-Za-z0-9_]+)/);
      return m ? [m[1], m[2]] : null;
    })
    .filter(Boolean) as string[][];
  const chain = longestChain(edges);
  if (chain > threshold && /flowchart\s+LR/i.test(diagram)) {
    return diagram.replace(/flowchart\s+LR/i, "flowchart TD");
  }
  return diagram;
}

function longestChain(edges: string[][]): number {
  const adj: Record<string, string[]> = {};
  for (const [a, b] of edges) {
    (adj[a] ??= []).push(b);
  }
  let best = 0;
  const visited = new Set<string>();
  const dfs = (n: string, depth: number) => {
    visited.add(n);
    best = Math.max(best, depth);
    for (const nb of adj[n] ?? []) {
      if (!visited.has(nb)) dfs(nb, depth + 1);
    }
    visited.delete(n);
  };
  for (const n of Object.keys(adj)) dfs(n, 1);
  return best;
}

function processPrFilesPrediction(
  fileLabelDict: Record<string, FileLabelEntry[]>,
  diffFiles: { filename: string; numPlusLines: number; numMinusLines: number }[],
  provider: GitHubProvider,
): string {
  const labels = Object.keys(fileLabelDict);
  if (!labels.length) return "<table><thead><tr><th></th><th align=\"left\">Relevant files</th></tr></thead><tbody></tbody></table>";
  const numFiles = labels.reduce((acc, l) => acc + fileLabelDict[l].length, 0);
  const collapsible = numFiles > COLLAPSIBLE_FILE_LIST_THRESHOLD;

  let out = "<table>";
  out += `<thead><tr><th></th><th align="left">Relevant files</th></tr></thead>`;
  out += "<tbody>";
  for (const label of labels) {
    const sLabel = label.replace(/['"]/g, "");
    out += `<tr><td><strong>${sLabel.charAt(0).toUpperCase() + sLabel.slice(1)}</strong></td>`;
    out += collapsible
      ? `<td><details><summary>${fileLabelDict[label].length} files</summary><table>`
      : `<td><table>`;
    for (const f of fileLabelDict[label]) {
      const filename = f.filename.replace(/'/g, "`").replace(/"/g, "`").replace(/\s+$/, "");
      let filenamePublish = filename.split("/").pop() ?? filename;
      if (f.changesTitle && f.changesTitle.trim() !== "...") {
        const code = `<code>${f.changesTitle}</code>`;
        const codeBr = insertBrAfterXChars(code, 70);
        filenamePublish = `<strong>${filenamePublish}</strong><dd>${codeBr}</dd>`;
      } else {
        filenamePublish = `<strong>${filenamePublish}</strong>`;
      }
      // diff stats
      let diffPlusMinus = "";
      let deltaNbsp = "";
      const df = diffFiles.find(
        (x) => x.filename.toLowerCase().replace(/^\/+/, "") === filename.toLowerCase().replace(/^\/+/, ""),
      );
      if (df) {
        diffPlusMinus = `+${df.numPlusLines}/-${df.numMinusLines}`;
        if (diffPlusMinus.length > 12 || diffPlusMinus === "+0/-0") diffPlusMinus = "[link]";
        deltaNbsp = "&nbsp; ".repeat(Math.max(0, 8 - diffPlusMinus.length));
      }
      // line link (best effort)
      let link = "";
      try {
        link = provider.getLineLink(filename, -1) as unknown as string;
        link = "";
      } catch {
        link = "";
      }
      const descBr = insertBrAfterXChars(f.changesSummary, 70);
      out += collapsible
        ? ""
        : `<tr>\n  <td>\n    <details>\n      <summary>${filenamePublish}</summary>\n<hr>\n\n${filename}\n\n${descBr}\n\n\n</details>\n\n\n  </td>\n  <td>${diffPlusMinus}${deltaNbsp}</td>\n\n</tr>\n`;
    }
    out += collapsible ? `</table></details></td></tr>` : `</table></td></tr>`;
  }
  out += `</tr></tbody></table>`;
  return out;
}

export function insertBrAfterXChars(text: string, x: number): string {
  let out = "";
  let count = 0;
  for (const ch of text) {
    out += ch;
    if (ch !== "<" && ch !== ">" && ch !== "&") {
      count++;
      if (count >= x) {
        out += "<br>";
        count = 0;
      }
    }
  }
  return out.trim();
}