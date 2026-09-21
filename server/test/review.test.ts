// Tests for diff processing, YAML parsing, token counting, markdown render.

import { describe, expect, test } from "bun:test";
import {
  decoupleAndConvertToHunksWithLinesNumbers,
  extendPatch,
  generateFullPatch,
  handlePatchDeletions,
  omitDeletionHunks,
  parseHunkHeader,
  type FilePatchInfo,
  EditType,
} from "../src/diff";
import { loadYaml } from "../src/yaml";
import { countTokens } from "../src/token";
import { convertToMarkdownV2 } from "../src/markdown";
import { renderTemplate } from "../src/render";
import { loadConfig, getModelTokenLimit } from "../src/config";
import { REVIEW_SYSTEM_TEMPLATE, REVIEW_USER_TEMPLATE } from "../src/prompts";

describe("diff processing", () => {
  test("parseHunkHeader", () => {
    expect(parseHunkHeader("@@ -12,4 +13,6 @@ def foo()")).toEqual({
      start1: 12,
      size1: 4,
      start2: 13,
      size2: 6,
      sectionHeader: "def foo()",
    });
    expect(parseHunkHeader("@@ -1 +1 @@")).toEqual({
      start1: 1,
      size1: 1,
      start2: 1,
      size2: 1,
      sectionHeader: "",
    });
  });

  test("omitDeletionHunks drops delete-only hunks", () => {
    const patch = [
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old",
      "+new",
      " line3",
      "@@ -5,3 +5,1 @@",
      "-a",
      "-b",
      "+c",
      "@@ -10,2 +10,2 @@",
      "-gone1",
      "-gone2",
    ].join("\n");
    const out = omitDeletionHunks(patch);
    // hunks 1 (has +) and 2 (has +) kept; hunk 3 (delete-only) dropped
    expect(out).toContain("-old");
    expect(out).toContain("+new");
    expect(out).toContain("+c");
    expect(out).not.toContain("-gone1");
  });

  test("extendPatch adds context lines with line numbers", () => {
    const original = ["a", "b", "c", "d", "e", "f"].join("\n");
    const patch = "@@ -2,1 +2,1 @@\n b\n-c\n+d\n";
    const extended = extendPatch(patch, original, 1, 1, "test.ts");
    // extended hunk includes line before and after
    expect(extended).toContain("@@ -1,3 +1,3 @@");
    expect(extended).toContain(" a");
    expect(extended).toContain(" c");
  });

  test("decoupleAndConvertToHunksWithLinesNumbers", () => {
    const patch = "@@ -1,3 +1,3 @@\n line1\n-old\n+new\n line3\n";
    const file: FilePatchInfo = {
      filename: "src/x.py",
      baseFile: "line1\nold\nline3\n",
      headFile: "line1\nnew\nline3\n",
      patch,
      editType: EditType.MODIFIED,
      numPlusLines: 1,
      numMinusLines: 1,
    };
    const out = decoupleAndConvertToHunksWithLinesNumbers(patch, file);
    expect(out).toContain("## File: 'src/x.py'");
    expect(out).toContain("__new hunk__");
    expect(out).toContain("__old hunk__");
    // new hunk has numbered lines
    expect(out).toContain("1  line1");
    expect(out).toContain("2 +new");
    expect(out).toContain("-old");
  });

  test("deleted file renders marker", () => {
    const file: FilePatchInfo = {
      filename: "gone.py",
      baseFile: "x",
      headFile: "",
      patch: "",
      editType: EditType.DELETED,
      numPlusLines: 0,
      numMinusLines: 1,
    };
    const out = decoupleAndConvertToHunksWithLinesNumbers("", file);
    expect(out).toContain("was deleted");
  });

  test("generateFullPatch token budget", () => {
    const cfg = {
    ...loadConfig(),
    maxModelTokens: 200,
    customModelMaxTokens: 200,
    // disable soft/hard buffer so every file fits (mirrors test intent)
    outputBufferSoftThreshold: 0,
    outputBufferHardThreshold: 0,
  };
    const fileDict = [
      { filename: "a.py", patch: "aaa", tokens: 10, editType: EditType.MODIFIED },
      { filename: "b.py", patch: "bbb", tokens: 10, editType: EditType.MODIFIED },
    ];
    const res = generateFullPatch(fileDict, 100, 5, cfg, true);
    expect(res.patches.length).toBe(2);
    expect(res.remainingFiles.length).toBe(0);
    // with a tiny budget, one file is skipped
    const res2 = generateFullPatch(fileDict, 11, 10, cfg, true);
    expect(res2.patches.length).toBe(1);
    expect(res2.remainingFiles.length).toBe(1);
  });
});

describe("yaml", () => {
  test("loadYaml parses clean review", () => {
    const text = `review:
  score: 89
  relevant_tests: |
    No
  key_issues_to_review:
    - relevant_file: src/x.py
      issue_header: Possible Bug
      issue_content: something
      start_line: 12
      end_line: 14
`;
    const data = loadYaml(text, ["review:", "relevant_tests:"], "review", "security_concerns");
    expect(data).not.toBeNull();
    const review = (data as Record<string, unknown>)["review"] as Record<string, unknown>;
    expect(review["score"]).toBe(89);
    expect((review["key_issues_to_review"] as unknown[]).length).toBe(1);
  });

  test("loadYaml recovers from fenced yaml", () => {
    const text = "Here is the review:\n```yaml\nreview:\n  score: 42\n```\n";
    const data = loadYaml(text, [], "review", "security_concerns");
    expect((data as Record<string, unknown>)?.["review"]).toBeDefined();
  });
});

describe("tokens", () => {
  test("countTokens with o200k", () => {
    const n = countTokens("Hello world");
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
  });
});

describe("markdown", () => {
  test("convertToMarkdownV2 renders sections", () => {
    const md = convertToMarkdownV2(
      {
        review: {
          estimated_effort_to_review: "3",
          relevant_tests: "No",
          security_concerns: "No",
          key_issues_to_review: [],
          score: 89,
        },
      },
      true,
      true,
    );
    expect(md).toContain("## PR Reviewer Guide 🔍");
    expect(md).toContain("🔵");
    expect(md).toContain("No relevant tests");
    expect(md).toContain("Score");
  });
});

describe("render", () => {
  test("nunjucks StrictUndefined-equivalent", () => {
    expect(renderTemplate("{% if require_score %}s={{score}}{% endif %}", { require_score: true, score: 89 })).toBe("s=89");
    expect(() => renderTemplate("{{missing}}", {})).toThrow();
  });

  test("review prompts render with real vars", () => {
    const vars = {
      title: "feat: x",
      branch: "main",
      description: "desc",
      language: "TypeScript",
      diff: "diff",
      num_pr_files: 2,
      num_max_findings: 3,
      require_score: true,
      require_tests: true,
      require_estimate_effort_to_review: true,
      require_security_review: true,
      require_estimate_contribution_time_cost: false,
      require_can_be_split_review: false,
      require_todo_scan: false,
      question_str: "",
      answer_str: "",
      extra_instructions: "",
      skills_context: "",
      repo_context: "",
      commit_messages_str: "1. fix",
      custom_labels: "",
      enable_custom_labels: false,
      is_ai_metadata: false,
      related_tickets: [],
      duplicate_prompt_examples: false,
      date: "2026-09-21",
    };
    const sys = renderTemplate(REVIEW_SYSTEM_TEMPLATE, vars);
    expect(sys).toContain("You are PR-Reviewer");
    expect(sys).toContain("key_issues_to_review");
    const user = renderTemplate(REVIEW_USER_TEMPLATE, { ...vars, diff: "the diff" });
    expect(user).toContain("Title: feat: x");
    expect(user).toContain("the diff");
  });
});

describe("config", () => {
  test("model token limit", () => {
    const cfg = loadConfig();
    expect(getModelTokenLimit("claude-opus-5", cfg)).toBeLessThanOrEqual(128000);
  });
});