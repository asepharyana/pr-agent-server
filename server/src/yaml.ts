// YAML loading with pr_agent's resilient fallback chain.
// Port of pr_agent.algo.utils.load_yaml + try_fix_yaml using the `yaml` package.

import * as YAML from "yaml";

export function loadYaml(
  responseText: string,
  keysFixYaml: string[] = [],
  firstKey = "",
  lastKey = "",
): Record<string, unknown> | null {
  const original = responseText;
  let text = responseText.replace(/^\n+/, "").trim();
  text = text
    .replace(/^yaml/, "")
    .replace(/^```yaml/, "")
    .replace(/\s*$/, "")
    .replace(/```$/, "");

  try {
    const data = YAML.parse(text);
    if (data && typeof data === "object") return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  return tryFixYaml(text, keysFixYaml, firstKey, lastKey, original);
}

const KEYS_YAML = [
  "relevant line:",
  "suggestion content:",
  "relevant file:",
  "existing code:",
  "improved code:",
  "label:",
  "why:",
  "suggestion_summary:",
];

export function tryFixYaml(
  responseText: string,
  keysFixYaml: string[] = [],
  firstKey = "",
  lastKey = "",
  original = "",
): Record<string, unknown> | null {
  let lines = responseText.split("\n");
  const keysYaml = [...KEYS_YAML, ...keysFixYaml];

  // fallback 1: convert 'key: value' to 'key: |-' multiline
  let copy = lines.map((l) => {
    for (const key of keysYaml) {
      if (l.includes(key) && !l.includes("|")) {
        return l.replace(key, `${key} |\n        `);
      }
    }
    return l;
  });
  let data = tryParse(copy.join("\n"));
  if (data) return data;

  // 1.5: '|\n' → '|2\n'
  copy = responseText.replace(/\|\n/g, "|2\n").split("\n");
  data = tryParse(copy.join("\n"));
  if (data) return data;
  // 1.5b: add 4-space indent to lines at depth 2 containing '}'
  const copyB = copy.map((l) => {
    const initSpace = l.length - l.trimStart().length;
    if (initSpace === 2 && !l.includes("|2") && l.includes("}")) {
      return "    " + l.trimStart();
    }
    return l;
  });
  data = tryParse(copyB.join("\n"));
  if (data) return data;

  // fallback 2: extract yaml fenced block
  const snippetPattern = /```(yaml|yml)?([\s\S]*?)```(?=\s*$|")/;
  let m = snippetPattern.exec(copy.join("\n"));
  if (!m) m = snippetPattern.exec(original);
  if (m && m[2]) {
    data = tryParse(m[2]);
    if (data) return data;
  }

  // fallback 3: remove leading/trailing braces
  let t3 = responseText
    .trim()
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .replace(/:$/, "");
  data = tryParse(t3);
  if (data) return data;

  // fallback 4: extract from first_key to after last_key
  if (firstKey && lastKey) {
    let idxStart = responseText.indexOf(`\n${firstKey}:`);
    if (idxStart === -1) idxStart = responseText.indexOf(`${firstKey}:`);
    const idxLast = responseText.lastIndexOf(`${lastKey}:`);
    let idxEnd = responseText.indexOf("\n\n", idxLast);
    if (idxEnd === -1) idxEnd = responseText.length;
    const t4 = responseText
      .slice(idxStart, idxEnd)
      .trim()
      .replace(/^```yaml/, "")
      .replace(/^`/, "")
      .replace(/`$/, "");
    if (t4) {
      data = tryParse(t4);
      if (data) return data;
    }
  }

  // fallback 5: remove leading '+'
  copy = lines.map((l) => (l.startsWith("+") ? " " + l.slice(1) : l));
  data = tryParse(copy.join("\n"));
  if (data) return data;

  // fallback 6: tabs → spaces
  if (responseText.includes("\t")) {
    data = tryParse(responseText.replace(/\t/g, "    "));
    if (data) return data;
  }

  // fallback 7: indent sections for code blocks
  const improveSections = ["existing_code:", "improved_code:", "response:", "why:"];
  const describeSections = ["description:", "title:", "changes_diagram:", "pr_files:", "pr_ticket:"];
  let startLine = -1;
  const lines7 = responseText.split("\n").map((l, i) => {
    const strip = l.trimEnd();
    if (improveSections.some((k) => strip.includes(k)) || describeSections.some((k) => strip.includes(k))) {
      startLine = i;
      return l;
    } else if (
      strip.endsWith(": |") || strip.endsWith(": |-") || strip.endsWith(": |2") ||
      keysYaml.some((k) => strip.endsWith(k))
    ) {
      startLine = -1;
      return l;
    } else if (startLine !== -1) {
      return "    " + l;
    }
    return l;
  });
  const t7 = lines7.join("\n").replace(/ \|\n/g, " |2\n");
  data = tryParse(t7);
  if (data) return data;

  // fallback 8: strip leading pipes
  data = tryParse(responseText.replace(/^\|\n/, ""));
  if (data) return data;

  return null;
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const d = YAML.parse(text);
    if (d && typeof d === "object") return d as Record<string, unknown>;
  } catch {
    // ignore
  }
  return null;
}