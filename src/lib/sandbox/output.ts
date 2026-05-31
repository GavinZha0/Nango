/**
 * stdout / stderr post-processing: truncation + path masking.
 *
 * See docs/sandbox.md.
 */

import { maskOutput, type PathMapping } from "./path-mapper";
import { getConfigNumber } from "@/lib/config";

const DEFAULT_MAX_STDOUT_CHARS = 20_000;
const DEFAULT_MAX_STDERR_CHARS = 10_000;

/**
 * Mid-string truncation: keep the first half + a marker + the last
 * half. The most useful information in stdout (final answers,
 * tabular results) is at the tail; the start often holds the
 * question echo or initial prints. Keeping both halves preserves
 * the typical flow.
 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  const half = Math.floor(max / 2);
  return (
    text.slice(0, half) +
    `\n... [truncated ${dropped} chars] ...\n` +
    text.slice(text.length - half)
  );
}

/**
 * End-truncation: keep the tail. Stack traces / panic dumps are
 * usually best read from the bottom — top frames are noise.
 */
export function truncateEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `... [truncated ${dropped} chars] ...\n` + text.slice(-max);
}

/** Apply the standard stdout pipeline: mask host paths → mid-truncate. */
export function processStdout(raw: string, mapping: PathMapping): string {
  const max = getConfigNumber("sandbox.stdout_max_chars", DEFAULT_MAX_STDOUT_CHARS);
  return truncateMiddle(maskOutput(raw, mapping), max);
}

/** Apply the standard stderr pipeline: mask host paths → end-truncate. */
export function processStderr(raw: string, mapping: PathMapping): string {
  const max = getConfigNumber("sandbox.stderr_max_chars", DEFAULT_MAX_STDERR_CHARS);
  return truncateEnd(maskOutput(raw, mapping), max);
}
