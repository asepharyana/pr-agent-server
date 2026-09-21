// Markdown rendering — port of pr_agent.algo.utils.convert_to_markdown_v2.
// Converts the parsed review YAML into the "# PR Reviewer Guide 🔍" comment.

const EMOJIS: Record<string, string> = {
  "Can be split": "🔀",
  "Key issues to review": "⚡",
  "Recommended focus areas for review": "⚡",
  Score: "🏅",
  "Relevant tests": "🧪",
  "Focused PR": "✨",
  "Relevant ticket": "🎫",
  "Security concerns": "🔒",
  "Todo sections": "📝",
  "Insights from user's answers": "📝",
  "Code feedback": "🤖",
  "Estimated effort to review [1-5]": "⏱️",
  "Contribution time cost estimate": "⏳",
  "Ticket compliance check": "🎫",
};

export interface ReviewData {
  review: Record<string, unknown>;
}

export function convertToMarkdownV2(
  outputData: ReviewData,
  gfmSupported = true,
  enableIntroText = false,
): string {
  let md = "## PR Reviewer Guide 🔍\n\n";
  const review = outputData.review || {};
  if (!Object.keys(review).length) return "";

  const todoSummary = (review["todo_summary"] as string) || "";

  // pop todo_summary (it's not rendered as a row)
  const entries = Object.entries(review).filter(([k]) => k !== "todo_summary");

  if (gfmSupported) md += "<table>\n";

  for (const [key, value] of entries) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && Object.keys(value).length === 0)) {
      if (!["can_be_split", "key_issues_to_review"].includes(key.toLowerCase())) continue;
    }
    const keyNice = key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    const emoji = EMOJIS[keyNice] || "";

    if (keyNice.includes("Estimated effort to review")) {
      const k = "Estimated effort to review";
      let str = String(value).trim();
      let intVal: number;
      if (/^\d+$/.test(str)) intVal = parseInt(str, 10);
      else {
        const m = /^\s*(\d+)/.exec(str);
        if (!m) continue;
        intVal = parseInt(m[1], 10);
      }
      const blue = "🔵".repeat(intVal);
      const white = "⚪".repeat(Math.max(0, 5 - intVal));
      const v = `${intVal} ${blue}${white}`;
      if (gfmSupported) md += `<tr><td>${emoji}&nbsp;<strong>${k}</strong>: ${v}</td></tr>\n`;
      else md += `### ${emoji} ${k}: ${v}\n\n`;
    } else if (keyNice.toLowerCase().includes("relevant tests")) {
      const v = String(value).trim().toLowerCase();
      if (gfmSupported) {
        md += `<tr><td>${emoji}&nbsp;<strong>${isValueNo(v) ? "No relevant tests" : "PR contains tests"}</strong></td></tr>\n`;
      } else {
        md += `### ${emoji} ${isValueNo(v) ? "No relevant tests" : "PR contains tests"}\n\n`;
      }
    } else if (keyNice.toLowerCase().includes("ticket compliance check")) {
      md += renderTicketCompliance(emoji, value, gfmSupported);
    } else if (keyNice.toLowerCase().includes("contribution time cost estimate")) {
      const obj = value as Record<string, string>;
      const best = expandMinuteSuffix(String(obj["best_case"] ?? ""));
      const avg = expandMinuteSuffix(String(obj["average_case"] ?? ""));
      const worst = expandMinuteSuffix(String(obj["worst_case"] ?? ""));
      if (gfmSupported) {
        md += `<tr><td>${emoji}&nbsp;<strong>Contribution time estimate</strong> (best, average, worst case): ${best} | ${avg} | ${worst}</td></tr>\n`;
      } else {
        md += `### ${emoji} Contribution time estimate (best, average, worst case): ${best} | ${avg} | ${worst}\n\n`;
      }
    } else if (keyNice.toLowerCase().includes("security concerns")) {
      if (isValueNo(String(value))) {
        if (gfmSupported) md += `<tr><td>${emoji}&nbsp;<strong>No security concerns identified</strong></td></tr>\n`;
        else md += `### ${emoji} No security concerns identified\n\n`;
      } else {
        const v = emphasizeHeader(String(value).trim());
        if (gfmSupported) md += `<tr><td>${emoji}&nbsp;<strong>Security concerns</strong><br><br>\n\n${v}</td></tr>\n`;
        else md += `### ${emoji} Security concerns\n\n${v}\n\n`;
      }
    } else if (keyNice.toLowerCase().includes("todo sections")) {
      // todo handled by plain value
      if (gfmSupported) {
        md += `<tr><td>${emoji}&nbsp;<strong>Todo sections</strong><br><br>\n\n${String(value)}\n</td></tr>\n`;
      } else {
        md += `### ${emoji} Todo sections\n\n${String(value)}\n\n`;
      }
    } else if (keyNice.toLowerCase().includes("can be split")) {
      // list of sub-prs; render as items
      if (gfmSupported) {
        md += `<tr><td>${emoji}&nbsp;<strong>Can be split</strong><br><br>\n`;
        for (const item of value as { title: string; relevant_files: string[] }[]) {
          md += `- **${item.title}**\n`;
          for (const f of item.relevant_files) md += `  - \`${f}\`\n`;
        }
        md += `</td></tr>\n`;
      }
    } else if (keyNice.toLowerCase().includes("key issues to review")) {
      // array of {relevant_file, relevant_line, suggestion} objects (or string)
      const items = Array.isArray(value) ? value : [value];
      let v = "";
      const parts: string[] = [];
      for (const it of items) {
        if (typeof it === "string") {
          parts.push(it);
          continue;
        }
        const o = (it ?? {}) as Record<string, string>;
        const file = o["relevant_file"] || "";
        const line = o["relevant_line"] || "";
        const sug = o["suggestion"] || "";
        const loc = file ? `${file}${line ? `:${line}` : ""}` : "";
        parts.push(loc ? `**${loc}** — ${sug}` : sug);
      }
      v = parts.filter(Boolean).join("\n\n") || "No key issues identified";
      if (gfmSupported) {
        md += `<tr><td>${emoji}&nbsp;<strong>Key issues to review</strong><br><br>\n\n${v}\n</td></tr>\n`;
      } else {
        md += `### ${emoji} Key issues to review\n\n${v}\n\n`;
      }
    } else if (keyNice === "Score") {
      if (gfmSupported) md += `<tr><td>${emoji}&nbsp;<strong>Score</strong>: ${String(value)}</td></tr>\n`;
      else md += `### ${emoji} Score: ${String(value)}\n\n`;
    } else if (keyNice.toLowerCase().includes("insights from user's answers")) {
      if (gfmSupported) md += `<tr><td>${emoji}&nbsp;<strong>Insights from user's answers</strong><br><br>\n\n${String(value)}\n</td></tr>\n`;
      else md += `### ${emoji} Insights from user's answers\n\n${String(value)}\n\n`;
    } else {
      // generic row
      const label = keyNice;
      if (gfmSupported) md += `<tr><td>${emoji}&nbsp;<strong>${label}</strong>: ${String(value)}</td></tr>\n`;
      else md += `### ${emoji} ${label}: ${String(value)}\n\n`;
    }
  }

  if (gfmSupported) md += "</table>\n";
  return md.trimEnd() + "\n";
}

export function isValueNo(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "no" || v === "none" || v === "n/a" || v === "na";
}

export function expandMinuteSuffix(s: string): string {
  return s.replace(/(\d+)(m|h|d)/g, "$1 $2");
}

export function emphasizeHeader(s: string): string {
  // bold anything before the first ':' if short
  const lines = s.split("\n").map((l) => {
    const m = /^([^:]{1,60}):(.*)$/.exec(l);
    if (m && m[1].trim()) return `**${m[1].trim()}**:${m[2]}`;
    return l;
  });
  return lines.join("\n");
}

function renderTicketCompliance(
  emoji: string,
  value: unknown,
  gfm: boolean,
): string {
  const items = Array.isArray(value) ? value : [];
  let out = "";
  if (items.length === 0) return out;
  for (const t of items) {
    if (gfm) {
      const tObj = t as Record<string, string>;
      const url = tObj["ticket_url"] || "";
      const compliance = tObj["overall_compliance_level"] || tObj["ticket_compliance_level"] || "";
      const explanation = tObj["explanation"] || tObj["why_compliance_level_partial"] || "";
      out += `<tr><td>${emoji}&nbsp;<strong>Ticket compliance check</strong><br><br>\n`;
      if (url && url.trim()) {
        const id = url.trim().split("/").filter(Boolean).pop() || url.trim();
        out += `**[${id}](<${url.trim()}>) — ${compliance || "Partially"}**\n\n`;
      } else {
        out += `**${compliance || "Partially"}**\n\n`;
      }
      if (explanation?.trim()) out += `${explanation.trim()}\n`;
      out += `</td></tr>\n`;
    }
  }
  return out;
}