/**
 * Jailed filesystem search primitives (`find_files` and `grep_files`).
 *
 * SECURITY: Walk strictly skips symlinks (`entry.isSymbolicLink()`) so
 * directory traversal can never escape the jail or follow links into
 * outside trees.
 *
 * See docs/host-files.md.
 */

import "server-only";

import { isUtf8 } from "node:buffer";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { FindFilesMatch, GrepMatch } from "./schema";

export const DEFAULT_FIND_LIMIT = 200;
export const DEFAULT_GREP_LIMIT = 100;
export const MAX_SEARCH_FILES_SCANNED = 5_000;
const MAX_LINE_SNIPPET_CHARS = 500;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "__pycache__",
  ".venv",
]);

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a POSIX-style glob pattern (`**`, `*`, `?`, `{a,b}`) into a RegExp
 * anchored to the full relative path.
 */
export function compileGlob(rawPattern: string): RegExp {
  const normalized = rawPattern
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  let regex = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        const after = normalized[i + 2];
        if (after === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (ch === "{") {
      const closeIdx = normalized.indexOf("}", i + 1);
      if (closeIdx !== -1) {
        const inner = normalized.slice(i + 1, closeIdx);
        const parts = inner.split(",").map((p) =>
          Array.from(p)
            .map((c) => escapeRegexChar(c))
            .join(""),
        );
        regex += `(?:${parts.join("|")})`;
        i = closeIdx + 1;
      } else {
        regex += escapeRegexChar(ch);
        i += 1;
      }
    } else {
      regex += escapeRegexChar(ch);
      i += 1;
    }
  }
  regex += "$";

  return new RegExp(regex, process.platform === "win32" ? "i" : "");
}

interface WalkedFile {
  absPath: string;
  /** Path relative to the search root (posix separators). */
  searchRelPath: string;
  /** Path relative to `host.file.root` (posix separators). */
  jailRelPath: string;
  sizeBytes: number;
  modifiedAt: string;
}

async function* walkJailedFiles(
  startAbsDir: string,
  startJailRel: string,
  state: { scanned: number; hitCap: boolean },
): AsyncGenerator<WalkedFile> {
  const queue: Array<{ absDir: string; searchRel: string; jailRel: string }> = [
    { absDir: startAbsDir, searchRel: "", jailRel: startJailRel },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current.absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      // SECURITY: Never follow symlinks inside the jail.
      if (entry.isSymbolicLink()) continue;

      const absChild = path.join(current.absDir, entry.name);
      const searchRel = current.searchRel
        ? `${current.searchRel}/${entry.name}`
        : entry.name;
      const jailRel = current.jailRel
        ? `${current.jailRel}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        queue.push({ absDir: absChild, searchRel, jailRel });
      } else if (entry.isFile()) {
        state.scanned += 1;
        if (state.scanned > MAX_SEARCH_FILES_SCANNED) {
          state.hitCap = true;
          return;
        }
        try {
          const st = await stat(absChild);
          yield {
            absPath: absChild,
            searchRelPath: searchRel,
            jailRelPath: jailRel,
            sizeBytes: st.size,
            modifiedAt: st.mtime.toISOString(),
          };
        } catch {
          // Skip transient or unreadable files
        }
      }
    }
  }
}

export async function runFindFiles(input: {
  absDir: string;
  jailRelDir: string;
  pattern: string;
  limit?: number;
}): Promise<{
  files: FindFilesMatch[];
  totalScanned: number;
  truncated: boolean;
}> {
  const limit = input.limit ?? DEFAULT_FIND_LIMIT;
  const matcher = compileGlob(input.pattern);
  const state = { scanned: 0, hitCap: false };
  const files: FindFilesMatch[] = [];
  let truncated = false;

  for await (const file of walkJailedFiles(
    input.absDir,
    input.jailRelDir,
    state,
  )) {
    if (matcher.test(file.searchRelPath)) {
      if (files.length >= limit) {
        truncated = true;
        break;
      }
      files.push({
        path: file.jailRelPath,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
      });
    }
  }

  return {
    files,
    totalScanned: Math.min(state.scanned, MAX_SEARCH_FILES_SCANNED),
    truncated: truncated || state.hitCap,
  };
}

export async function runGrepFiles(input: {
  absTarget: string;
  jailRelTarget: string;
  isFile: boolean;
  query: string;
  glob?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  limit?: number;
  maxBytesBudget: number;
}): Promise<{
  matches: GrepMatch[];
  filesSearched: number;
  truncated: boolean;
}> {
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  const caseSensitive = input.caseSensitive ?? false;
  const globMatcher = input.glob ? compileGlob(input.glob) : null;

  let regex: RegExp | null = null;
  if (input.isRegex) {
    regex = new RegExp(input.query, caseSensitive ? "" : "i");
  }
  const needle = caseSensitive ? input.query : input.query.toLowerCase();

  const matches: GrepMatch[] = [];
  let filesSearched = 0;
  let totalResultBytes = 0;
  let truncated = false;

  const searchOneFile = async (absPath: string, jailRelPath: string, sizeBytes: number) => {
    if (sizeBytes === 0 || sizeBytes > input.maxBytesBudget) return;
    let buf: Buffer;
    try {
      buf = await readFile(absPath);
    } catch {
      return;
    }
    if (!isUtf8(buf) || buf.includes(0)) return;

    filesSearched += 1;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const lineText = lines[idx]!;
      const hit = regex
        ? regex.test(lineText)
        : (caseSensitive ? lineText : lineText.toLowerCase()).includes(needle);

      if (!hit) continue;

      if (matches.length >= limit) {
        truncated = true;
        return;
      }

      const snippet =
        lineText.length > MAX_LINE_SNIPPET_CHARS
          ? `${lineText.slice(0, MAX_LINE_SNIPPET_CHARS)}…`
          : lineText;
      const entryBytes = Buffer.byteLength(jailRelPath, "utf8") + Buffer.byteLength(snippet, "utf8") + 32;
      if (totalResultBytes + entryBytes > input.maxBytesBudget && matches.length > 0) {
        truncated = true;
        return;
      }

      totalResultBytes += entryBytes;
      matches.push({
        path: jailRelPath,
        line: idx + 1,
        text: snippet,
      });
    }
  };

  if (input.isFile) {
    const st = await stat(input.absTarget);
    await searchOneFile(input.absTarget, input.jailRelTarget, st.size);
    return { matches, filesSearched, truncated };
  }

  const state = { scanned: 0, hitCap: false };
  for await (const file of walkJailedFiles(
    input.absTarget,
    input.jailRelTarget,
    state,
  )) {
    if (globMatcher && !globMatcher.test(file.searchRelPath)) continue;
    await searchOneFile(file.absPath, file.jailRelPath, file.sizeBytes);
    if (truncated) break;
  }

  return {
    matches,
    filesSearched,
    truncated: truncated || state.hitCap,
  };
}
