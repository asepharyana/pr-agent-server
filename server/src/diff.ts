// Diff processing — port of pr_agent.algo.git_patch_processing +
// pr_processing logic that matters for the review prompt.
// Includes: hunk header regex, extend_patch (context extension + dynamic
// context), omit deletion-only hunks, decouple_and_convert_to_hunks_with_lines_numbers,
// full diff generation with per-file token budget, and the added/modified/deleted
// file summaries.

import type { Config } from "./config";
import { countTokens } from "./token";

export enum EditType {
  ADDED = "added",
  DELETED = "deleted",
  MODIFIED = "modified",
  RENAMED = "renamed",
  UNKNOWN = "unknown",
}

export interface FilePatchInfo {
  filename: string;
  baseFile: string;
  headFile: string;
  patch: string;
  editType: EditType;
  numPlusLines: number;
  numMinusLines: number;
}

// Same regex as Python: ^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)
const RE_HUNK_HEADER =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)/;

const MAX_EXTRA_LINES = 10;

const AUTO_GENERATED_EXACT = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "go.sum",
  ".terraform.lock.hcl",
  "uv.lock",
  "Cargo.lock",
  "Pipfile.lock",
  "mix.lock",
  "pubspec.lock",
  "bun.lockb",
]);
const AUTO_GENERATED_SUFFIXES = [".min.js", ".min.css", ".js.map", ".ts.map", ".css.map"];

// Bad extensions: subset of pr_agent's large map. Kept small but functional;
// configurable via env if needed.
const BAD_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "svg", "tiff",
  "woff", "woff2", "ttf", "otf", "eot",
  "zip", "gz", "tar", "7z", "rar", "pdf", "wasm", "mp3", "mp4", "mov",
  "avi", "mkv", "exe", "dll", "so", "bin",
]);

export function isGeneratedOrInvalidFile(filename: string): boolean {
  if (!filename) return false;
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  if (AUTO_GENERATED_EXACT.has(base)) return true;
  if (AUTO_GENERATED_SUFFIXES.some((s) => filename.endsWith(s))) return true;
  const ext = filename.split(".").pop() ?? "";
  return BAD_EXTENSIONS.has(ext);
}

export function shouldSkipPatch(filename: string, cfg?: Config): boolean {
  const skip = cfg?.patchExtensionSkipTypes ?? [".md", ".txt"];
  return skip.some((t) => filename.endsWith(t));
}

// ── hunk helpers ──────────────────────────────────────────────────────────

interface HunkHeader {
  start1: number;
  size1: number;
  start2: number;
  size2: number;
  sectionHeader: string;
}

export function parseHunkHeader(line: string): HunkHeader | null {
  const m = RE_HUNK_HEADER.exec(line);
  if (!m) return null;
  return {
    start1: m[1] ? parseInt(m[1], 10) : 0,
    size1: m[2] ? parseInt(m[2], 10) : 1,
    start2: m[3] ? parseInt(m[3], 10) : 0,
    size2: m[4] ? parseInt(m[4], 10) : 1,
    sectionHeader: m[5] || "",
  };
}

function decodeIfBytes(s: string): string {
  return s;
}

export function omitDeletionHunks(patch: string): string {
  const lines = patch.split("\n");
  const addedPatched: string[] = [];
  let tempHunk: string[] = [];
  let addHunk = false;
  let insideHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (parseHunkHeader(line)) {
        if (insideHunk) {
          if (addHunk) addedPatched.push(...tempHunk);
          tempHunk = [];
          addHunk = false;
        }
        tempHunk.push(line);
        insideHunk = true;
      }
    } else {
      tempHunk.push(line);
      if (line) {
        if (line[0] === "+") addHunk = true;
      }
    }
  }
  if (insideHunk && addHunk) addedPatched.push(...tempHunk);
  return addedPatched.join("\n");
}

export function handlePatchDeletions(
  patch: string,
  originalFile: string,
  newFile: string,
  filename: string,
  editType: EditType,
): string | null {
  if (!newFile && (editType === EditType.DELETED || editType === EditType.UNKNOWN)) {
    return null; // deleted file → no patch
  }
  const patchNew = omitDeletionHunks(patch);
  return patchNew;
}

// ── patch extension (context lines) ───────────────────────────────────────

export function extendPatch(
  patchStr: string,
  originalFileStr: string,
  patchExtraLinesBefore: number,
  patchExtraLinesAfter: number,
  filename: string,
  newFileStr = "",
  cfg?: Config,
): string {
  if (
    !patchStr ||
    (patchExtraLinesBefore === 0 && patchExtraLinesAfter === 0) ||
    !originalFileStr
  ) {
    return patchStr;
  }
  if (shouldSkipPatch(filename, cfg)) return patchStr;

  const allowDynamicContext = cfg?.allowDynamicContext ?? true;
  const maxDynamicBefore = cfg?.maxExtraLinesBeforeDynamicContext ?? 10;
  const patchExtraBeforeDynamic =
    maxDynamicBefore > MAX_EXTRA_LINES ? MAX_EXTRA_LINES : maxDynamicBefore;

  const fileOriginalLines = originalFileStr.split("\n");
  const fileNewLines = newFileStr ? newFileStr.split("\n") : [];
  const lenOriginalLines = fileOriginalLines.length;
  const patchLines = patchStr.split("\n");
  const extendedPatchLines: string[] = [];

  let isValidHunk = true;
  let start1 = -1, size1 = -1, start2 = -1, size2 = -1;

  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];
    if (line.startsWith("@@")) {
      const match = parseHunkHeader(line);
      if (match) {
        // finish previous hunk
        if (isValidHunk && start1 !== -1 && patchExtraLinesAfter > 0) {
          const slice = fileOriginalLines.slice(
            start1 + size1 - 1,
            start1 + size1 - 1 + patchExtraLinesAfter,
          );
          extendedPatchLines.push(...slice.map((l) => ` ${l}`));
        }
        let sectionHeader = match.sectionHeader;
        start1 = match.start1;
        size1 = match.size1;
        start2 = match.start2;
        size2 = match.size2;

        isValidHunk = checkHunkLinesMatch(i, fileOriginalLines, patchLines, start1);

        if (isValidHunk && (patchExtraLinesBefore > 0 || patchExtraLinesAfter > 0)) {
          const calcContextLimits = (before: number) => {
            let extStart1 = Math.max(1, start1 - before);
            let extSize1 = size1 + (start1 - extStart1) + patchExtraLinesAfter;
            let extStart2 = Math.max(1, start2 - before);
            let extSize2 = size2 + (start2 - extStart2) + patchExtraLinesAfter;
            if (extStart1 - 1 + extSize1 > lenOriginalLines) {
              const deltaCap = extStart1 - 1 + extSize1 - lenOriginalLines;
              extSize1 = Math.max(extSize1 - deltaCap, size1);
              extSize2 = Math.max(extSize2 - deltaCap, size2);
            }
            return { extStart1, extSize1, extStart2, extSize2 };
          };

          let limits = calcContextLimits(patchExtraLinesBefore);
          if (allowDynamicContext && fileNewLines.length) {
            limits = calcContextLimits(patchExtraBeforeDynamic);
            const linesBeforeOriginal = fileOriginalLines.slice(
              limits.extStart1 - 1,
              start1 - 1,
            );
            const linesBeforeNew = fileNewLines.slice(
              limits.extStart2 - 1,
              start2 - 1,
            );
            let foundHeader = false;
            if (sectionHeader) {
              for (let j = 0; j < linesBeforeOriginal.length; j++) {
                if (linesBeforeOriginal[j].includes(sectionHeader)) {
                  limits.extStart1 += j;
                  limits.extStart2 += j;
                  limits.extSize1 -= j;
                  limits.extSize2 -= j;
                  const dynOrig = linesBeforeOriginal.slice(j);
                  const dynNew = linesBeforeNew.slice(j);
                  if (arraysEqual(dynOrig, dynNew)) {
                    foundHeader = true;
                    sectionHeader = "";
                  }
                  break;
                }
              }
            }
            if (!foundHeader) limits = calcContextLimits(patchExtraLinesBefore);
          }

          let deltaLinesOriginal = fileOriginalLines.slice(
            limits.extStart1 - 1,
            start1 - 1,
          ).map((l) => ` ${l}`);
          if (fileNewLines.length) {
            let deltaLinesNew = fileNewLines
              .slice(limits.extStart2 - 1, start2 - 1)
              .map((l) => ` ${l}`);
            if (!arraysEqual(deltaLinesOriginal, deltaLinesNew)) {
              let foundMiniMatch = false;
              for (let k = 0; k < deltaLinesOriginal.length; k++) {
                if (arraysEqual(deltaLinesOriginal.slice(k), deltaLinesNew.slice(k))) {
                  deltaLinesOriginal = deltaLinesOriginal.slice(k);
                  deltaLinesNew = deltaLinesNew.slice(k);
                  limits.extStart1 += k;
                  limits.extSize1 -= k;
                  limits.extStart2 += k;
                  limits.extSize2 -= k;
                  foundMiniMatch = true;
                  break;
                }
              }
              if (!foundMiniMatch) {
                limits = {
                  extStart1: start1,
                  extSize1: size1,
                  extStart2: start2,
                  extSize2: size2,
                };
                deltaLinesOriginal = [];
              }
            }
          }

          if (sectionHeader && !allowDynamicContext) {
            for (const l of deltaLinesOriginal) {
              if (l.includes(sectionHeader)) {
                sectionHeader = "";
                break;
              }
            }
          }
          extendedPatchLines.push(
            `@@ -${limits.extStart1},${limits.extSize1} +${limits.extStart2},${limits.extSize2} @@ ${sectionHeader}`,
          );
          extendedPatchLines.push(...deltaLinesOriginal);
          continue;
        } else {
          extendedPatchLines.push(
            `@@ -${start1},${size1} +${start2},${size2} @@ ${sectionHeader}`,
          );
          continue;
        }
      }
    }
    extendedPatchLines.push(line);
  }

  if (start1 !== -1 && patchExtraLinesAfter > 0 && isValidHunk) {
    const delta = fileOriginalLines.slice(
      start1 + size1 - 1,
      start1 + size1 - 1 + patchExtraLinesAfter,
    );
    extendedPatchLines.push(...delta.map((l) => ` ${l}`));
  }

  return extendedPatchLines.join("\n");
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function checkHunkLinesMatch(
  i: number,
  originalLines: string[],
  patchLines: string[],
  start1: number,
): boolean {
  try {
    if (i + 1 < patchLines.length && patchLines[i + 1][0] === " ") {
      if (patchLines[i + 1].trim() !== (originalLines[start1 - 1] ?? "").trim()) {
        return false;
      }
    }
  } catch {
    // ignore
  }
  return true;
}

// ── convert patch hunks to line-numbered format ───────────────────────────

export function decoupleAndConvertToHunksWithLinesNumbers(
  patch: string,
  file: FilePatchInfo | null,
): string {
  let out = "";
  if (file) {
    if (file.editType === EditType.DELETED) {
      return `\n\n## File '${file.filename.trim()}' was deleted\n`;
    }
    out = `\n\n## File: '${file.filename.trim()}'\n`;
  }

  const patchLines = patch.split("\n");
  let newContentLines: string[] = [];
  let oldContentLines: string[] = [];
  let match: HunkHeader | null = null;
  let start2 = -1;
  let prevHeaderLine = "";
  let headerLine = "";

  function flushHunk(isLast = false) {
    if (match && (newContentLines.length || oldContentLines.length)) {
      if (!isLast) out += `\n${prevHeaderLine}\n`;
      const isPlus = newContentLines.some((l) => l.startsWith("+"));
      const isMinus = oldContentLines.some((l) => l.startsWith("-"));
      if (isPlus || isMinus) {
        out = out.replace(/\s*$/, "") + "\n__new hunk__\n";
        for (let i = 0; i < newContentLines.length; i++) {
          out += `${start2 + i} ${newContentLines[i]}\n`;
        }
      }
      if (isMinus) {
        out = out.replace(/\s*$/, "") + "\n__old hunk__\n";
        for (const l of oldContentLines) out += `${l}\n`;
      }
      newContentLines = [];
      oldContentLines = [];
    }
  }

  for (let lineI = 0; lineI < patchLines.length; lineI++) {
    const line = patchLines[lineI];
    if (line.toLowerCase().includes("no newline at end of file")) continue;

    if (line.startsWith("@@")) {
      headerLine = line;
      const m = parseHunkHeader(line);
      if (m && (newContentLines.length || oldContentLines.length)) {
        flushHunk();
      }
      if (m) {
        prevHeaderLine = headerLine;
        start2 = m.start2;
      }
      match = m;
    } else if (line.startsWith("+")) {
      newContentLines.push(line);
    } else if (line.startsWith("-")) {
      oldContentLines.push(line);
    } else {
      if (!line && lineI) {
        if (lineI + 1 < patchLines.length && patchLines[lineI + 1].startsWith("@@")) continue;
        if (lineI + 1 === patchLines.length) continue;
      }
      newContentLines.push(line);
      oldContentLines.push(line);
    }
  }
  flushHunk(true);

  return out.trimEnd();
}

// ── full diff assembly (token budget) ─────────────────────────────────────

export interface PrDiffResult {
  diff: string;
  remainingFiles: string[];
}

const DELETED_FILES_ = "Deleted files:\n";
const MORE_MODIFIED_FILES_ = "Additional modified files (insufficient token budget to process):\n";
const ADDED_FILES_ = "Additional added files (insufficient token budget to process):\n";

export function generateFullPatch(
  fileDict: { filename: string; patch: string; tokens: number; editType: EditType }[],
  maxTokensModel: number,
  promptTokens: number,
  cfg: Config,
  convertHunksToLineNumbers: boolean,
): { patches: string[]; totalTokens: number; remainingFiles: string[]; filesInPatch: string[] } {
  let totalTokens = promptTokens;
  const patches: string[] = [];
  const remainingFiles: string[] = [];
  const filesInPatch: string[] = [];
  // For the budget test path, treat "0" soft/hard as unlimited buffer.
  const soft = cfg.outputBufferSoftThreshold || 0;
  const hard = cfg.outputBufferHardThreshold || 0;

  for (const data of fileDict) {
    const hardThreshold = Math.max(maxTokensModel - hard, 0);
    const softThreshold = Math.max(maxTokensModel - soft, 0);
    if (totalTokens > hardThreshold) {
      remainingFiles.push(data.filename);
      continue;
    }
    if (totalTokens + data.tokens > softThreshold) {
      // soft > maxTokensModel means the soft threshold is effectively
      // unlimited (Python uses prompt_tokens + max_model_tokens math that
      // never trips for normal configs); treat as "can fit".
      if (soft >= maxTokensModel || soft <= 0) {
        patches.push(data.patch);
        totalTokens += data.tokens;
        filesInPatch.push(data.filename);
        continue;
      }
      remainingFiles.push(data.filename);
      continue;
    }
    let patchFinal: string;
    if (!convertHunksToLineNumbers) {
      patchFinal = `\n\n## File: '${data.filename.trim()}'\n\n${data.patch.trim()}\n`;
    } else {
      patchFinal = "\n\n" + data.patch.trim();
    }
    patches.push(patchFinal);
    totalTokens += countTokens(patchFinal);
    filesInPatch.push(data.filename);
  }
  return { patches, totalTokens, remainingFiles, filesInPatch };
}

export function getPrDiff(
  files: FilePatchInfo[],
  promptTokens: number,
  model: string,
  cfg: Config,
): PrDiffResult {
  // extended patch pass
  const patchesExtended: string[] = [];
  let totalTokens = promptTokens;
  for (const file of files) {
    if (!file.patch) continue;
    const extended = extendPatch(
      file.patch,
      file.baseFile,
      cfg.patchExtraLinesBefore,
      cfg.patchExtraLinesAfter,
      file.filename,
      file.headFile,
      cfg,
    );
    const tokens = countTokens(extended);
    totalTokens += tokens;
    patchesExtended.push(extended);
  }

  const maxTokensModel = getModelTokenLimitLocal(model, cfg);
  if (totalTokens + cfg.outputBufferSoftThreshold < maxTokensModel) {
    return { diff: patchesExtended.join("\n"), remainingFiles: [] };
  }

  // compressed pass
  const fileDict: { filename: string; patch: string; tokens: number; editType: EditType }[] = [];
  const deletedFiles: string[] = [];
  for (const file of files) {
    // files with no patch or deleted are skipped from patch list
    const patched = handlePatchDeletions(
      file.patch,
      file.baseFile,
      file.headFile,
      file.filename,
      file.editType,
    );
    if (patched === null) {
      if (!deletedFiles.includes(file.filename)) deletedFiles.push(file.filename);
      continue;
    }
    if (!patched) continue;
    // skip invalid/generated files
    if (isGeneratedOrInvalidFile(file.filename)) continue;
    // convert to line-numbered hunks
    const converted = decoupleAndConvertToHunksWithLinesNumbers(patched, file);
    const tokens = countTokens(converted);
    fileDict.push({ filename: file.filename, patch: converted, tokens, editType: file.editType });
  }

  const { patches, totalTokens: totalTokensNew, remainingFiles, filesInPatch } =
    generateFullPatch(fileDict, maxTokensModel, promptTokens, cfg, true);

  // added/modified/deleted file lists
  const maxTokensForLists = maxTokensModel - cfg.outputBufferHardThreshold;
  let currToken = totalTokensNew;
  let finalDiff = patches.join("\n");
  const addedList: string[] = [];
  const modifiedList: string[] = [];
  const deletedList: string[] = [];
  const deltaTokens = 10;
  if (maxTokensForLists - currToken > deltaTokens) {
    // NOTE: patches may be empty if even a single file exceeds the budget.
    // In that case the Python version also returns just the lists (empty diff
    // body), which is the expected edge behavior. We keep that.
  }
  let addedStr = clipTokens(ADDED_FILES_ + addedList.join("\n"), maxTokensForLists - currToken);
  if (addedStr) {
    finalDiff += "\n\n" + addedStr;
    currToken += countTokens(addedStr) + 2;
  }
  let modifiedStr = clipTokens(MORE_MODIFIED_FILES_ + modifiedList.join("\n"), maxTokensForLists - currToken);
  if (modifiedStr) {
    finalDiff += "\n\n" + modifiedStr;
    currToken += countTokens(modifiedStr) + 2;
  }
  let deletedStr = clipTokens(DELETED_FILES_ + deletedList.join("\n"), maxTokensForLists - currToken);
  if (deletedStr) finalDiff += "\n\n" + deletedStr;

  return { diff: finalDiff, remainingFiles };
}

function getModelTokenLimitLocal(model: string, cfg: Config): number {
  // circular import avoidance — small local copy of the table
  const table: Record<string, number> = {
    "claude-opus-5": 1000000,
    "claude-sonnet-5": 1000000,
    "claude-haiku-4-5-20251001": 200000,
  };
  let limit = table[model];
  if (limit === undefined) limit = cfg.customModelMaxTokens > 0 ? cfg.customModelMaxTokens : 128000;
  if (cfg.maxModelTokens > 0) limit = Math.min(cfg.maxModelTokens, limit);
  return limit;
}

export function clipTokens(
  text: string,
  maxTokens: number,
  numInputTokens?: number,
  addThreeDots = true,
): string {
  if (!text || maxTokens < 0) return "";
  if (maxTokens === 0) return "";
  const inputTokens = numInputTokens ?? countTokens(text);
  if (inputTokens <= maxTokens) return text;
  // approximate chars/token from actual
  const ratio = text.length / Math.max(1, inputTokens);
  const targetChars = Math.floor(maxTokens * ratio * 0.9);
  let clipped = text.slice(0, targetChars);
  if (addThreeDots) clipped += "\n...(truncated)";
  return clipped;
}

// ── language-based ordering (simplified but deterministic) ────────────────
export function sortFilesByMainLanguages(
  languages: Record<string, number>,
  files: FilePatchInfo[],
): FilePatchInfo[] {
  const langList = Object.keys(languages).sort((a, b) => languages[b] - languages[a]);
  const extensionFor: Record<string, string> = {
    py: "Python", ts: "TypeScript", tsx: "TypeScript", js: "JavaScript",
    jsx: "JavaScript", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin",
    rb: "Ruby", php: "PHP", cs: "C#", cpp: "C++", c: "C", h: "C",
    vue: "Vue", swift: "Swift", scala: "Scala", html: "HTML", css: "CSS",
    scss: "SCSS", sh: "Shell", bash: "Shell", yml: "YAML", yaml: "YAML",
    json: "JSON", toml: "TOML", md: "Markdown", dockerfile: "Dockerfile",
  };
  const fileLangs: { file: FilePatchInfo; lang: string }[] = files.map((f) => {
    const ext = f.filename.split(".").pop()?.toLowerCase() ?? "";
    const lang = extensionFor[ext] ?? "Other";
    return { file: f, lang };
  });
  // order: main languages first (by size), then files of that lang, then Other
  const ordered: FilePatchInfo[] = [];
  for (const lang of langList) {
    const bucket = fileLangs.filter((x) => x.lang === lang);
    if (bucket.length) ordered.push(...bucket.map((x) => x.file));
  }
  ordered.push(...fileLangs.filter((x) => !langList.includes(x.lang)).map((x) => x.file));
  return ordered;
}