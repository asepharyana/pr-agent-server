// Tests for the PR description tool helpers (pure functions).

import { describe, expect, test } from "bun:test";
import {
  deriveLabels,
  sanitizeDiagram,
  insertBrAfterXChars,
} from "../src/describe";

describe("describe helpers", () => {
  test("deriveLabels from type list", () => {
    expect(deriveLabels({ type: ["Bug fix", "Enhancement"] })).toEqual([
      "Bug fix",
      "Enhancement",
    ]);
    expect(deriveLabels({ type: "Bug fix, Tests" })).toEqual(["Bug fix", "Tests"]);
    expect(deriveLabels({ labels: ["Bug fix"], type: ["Other"] })).toEqual(["Bug fix"]);
    expect(deriveLabels({})).toEqual([]);
  });

  test("sanitizeDiagram strips fences and rejects non-diagrams", () => {
    expect(sanitizeDiagram("```mermaid\nflowchart LR\n  A --> B\n```")).toBe(
      "flowchart LR\n  A --> B",
    );
    expect(sanitizeDiagram("plain text without diagram")).toBe("");
    expect(sanitizeDiagram("")).toBe("");
    expect(sanitizeDiagram("graph TD\n  A --> B")).toBe("graph TD\n  A --> B");
  });

  test("insertBrAfterXChars wraps long text", () => {
    const long = "a".repeat(80);
    const wrapped = insertBrAfterXChars(long, 70);
    expect(wrapped).toContain("<br>");
    expect(wrapped.replace(/<br>/g, "")).toBe(long);
    // html tags don't count toward the budget
    const withTag = insertBrAfterXChars("<code>abcdef</code>", 70);
    expect(withTag.length).toBe("<code>abcdef</code>".length);
  });
});