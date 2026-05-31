#!/usr/bin/env node
/**
 * Pre-commit guard: rejects D-rule violations in source comments.
 *
 * See docs/code-comments.md rule D — internal decision IDs, phase /
 * version markers, and doc section / fragment anchors must not survive
 * in source comments.
 *
 * Invoked by lint-staged with the list of staged files as argv. Exits
 * non-zero with a per-line report when violations are found.
 */

import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
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
    // D17 / D31 / D200 — word-boundary D followed by 1-3 digits, not
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
