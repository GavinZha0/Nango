#!/usr/bin/env node
/**
 * Pre-commit guard: rejects D-rule violations in source comments.
 *
 * See docs/code-comments.md rule D — internal decision IDs, phase /
 * version markers, and doc section / fragment anchors must not survive
 * in source comments.
 *
 * Invocations:
 *   - lint-staged passes the list of staged files as argv (default).
 *   - `--all` walks `src/` and `scripts/` for a full repo sweep
 *     (used by `pnpm comments:check:all`).
 *
 * Exits non-zero with a per-line report when violations are found.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sweepAll = argv.includes("--all");

// Roots scanned by `--all`. Tests and migrations stay out via SKIP_PATHS.
const SWEEP_ROOTS = ["src", "scripts"];
// Match what lint-staged scans: same extensions, exclude binaries.
const SWEEP_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// Directories we never recurse into during a sweep.
const SWEEP_SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "playwright-report",
  "test-results",
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SWEEP_SKIP_DIRS.has(entry.name)) continue;
      yield* walk(p);
    } else if (entry.isFile() && SWEEP_EXT.test(entry.name)) {
      yield p;
    }
  }
}

const files = sweepAll
  ? SWEEP_ROOTS.flatMap((r) => [...walk(r)])
  : argv.filter((a) => a !== "--all");
if (files.length === 0) process.exit(0);

const SKIP_PATHS = [
  /(^|\/)next-env\.d\.ts$/,
  /\/migrations\//,
  /\.snapshot\.json$/,
  /(^|\/)node_modules\//,
  /\.test\.(ts|tsx|js|mjs|cjs)$/,
  /\/__tests__\//,
  // The guide itself shows violation examples on purpose.
  /(^|\/)docs\/code-comments\.md$/,
  // This script is allowed to mention the patterns it detects.
  /(^|\/)scripts\/check-comment-rules\.mjs$/,
];

/**
 * Per-pattern detector. `re` is matched against each comment line; if a
 * match is NOT inside an allow-listed substring, it's reported.
 */
const PATTERNS = [
  {
    name: "decision id",
    // word-boundary D followed by 1-3 digits, not
    // followed by another letter or a dot (D3.js / D2D would fall here).
    re: /\bD\d{1,3}(?![a-zA-Z.])/,
    hint: 'drop the decision id; rewrite the surrounding line in plain prose.',
  },
  {
    name: "phase marker (W)",
    re: /\bW\d+\.\d/,
    hint: 'drop the W-phase marker; describe current behaviour instead.',
  },
  {
    name: "version marker",
    re: /\bV\d+\.[\dxX]/,
    hint: 'drop the version marker; current code is the only version that exists in the comment.',
  },
  {
    name: "section anchor (§N.M)",
    re: /§\d/,
    hint: 'replace with "See docs/<file>.md." — section numbers drift.',
  },
  {
    name: "fragment anchor",
    re: /\bdocs\/\S+#[a-z0-9-]/i,
    hint: 'replace with "See docs/<file>.md." — fragment names drift.',
  },
  {
    name: "phase ref",
    re: /\bPhase\s+[A-Z]-?\d/,
    hint: 'drop the phase reference; current behaviour stands on its own.',
  },
];

// Lines containing any of these are skipped wholesale (external
// standards refs etc.).
const ALLOW_LINE_HINTS = [
  /\bRFC\s+\d+\b/,
];

const COMMENT_PREFIX = /^\s*(?:\/\/|\*|\/\*|<!--)/;

function isCommentLine(line) {
  return COMMENT_PREFIX.test(line);
}

let total = 0;
const checked = [];

for (const file of files) {
  if (SKIP_PATHS.some((re) => re.test(file))) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  checked.push(file);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!isCommentLine(raw)) continue;
    if (ALLOW_LINE_HINTS.some((re) => re.test(raw))) continue;
    for (const { name, re, hint } of PATTERNS) {
      const m = raw.match(re);
      if (!m) continue;
      if (total === 0) {
        process.stderr.write(
          "\n[code-comments] D-rule violation(s) — see docs/code-comments.md rule D.\n\n",
        );
      }
      process.stderr.write(`  ${file}:${i + 1}  ${name} ("${m[0]}")\n`);
      process.stderr.write(`    > ${raw.trim()}\n`);
      process.stderr.write(`    hint: ${hint}\n\n`);
      total++;
      break;
    }
  }
}

if (total > 0) {
  process.stderr.write(
    `[code-comments] ${total} violation(s) across ${checked.length} file(s). ` +
      `Fix the lines above before committing.\n`,
  );
  process.exit(1);
}
