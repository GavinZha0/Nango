/**
 * Agent pipeline — G10 Untrusted Context Wrapping.
 *
 * Wraps untrusted external tool outputs inside structural delimiter markers
 * so the LLM parses the payload strictly as passive data, avoiding instruction hijacking.
 *
 * See docs/architecture-improvements.md "P1 — Safety Guardrails".
 */

import "server-only";

export const UNTRUSTED_START_MARKER = "<<<UNTRUSTED_SOURCE_DATA>>>";
export const UNTRUSTED_END_MARKER = "<<<END_UNTRUSTED_SOURCE_DATA>>>";

/**
 * Wrap untrusted external data within boundary delimiters.
 *
 * SECURITY: Pre-existing marker characters are escaped to prevent bypass
 * where attackers embed markers in controlled content to skip wrapping.
 */
export function wrapUntrustedContext(data: string): string {
  if (!data) return data;
  // Escape any pre-existing marker characters to prevent bypass
  const escaped = data
    .replaceAll(UNTRUSTED_START_MARKER, "<<<[ESCAPED]UNTRUSTED_SOURCE_DATA>>>")
    .replaceAll(UNTRUSTED_END_MARKER, "<<<[ESCAPED]END_UNTRUSTED_SOURCE_DATA>>>");
  return `${UNTRUSTED_START_MARKER}\n${escaped}\n${UNTRUSTED_END_MARKER}`;
}
