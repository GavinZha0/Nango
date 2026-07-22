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
 */
export function wrapUntrustedContext(data: string): string {
  if (!data) return data;
  if (data.includes(UNTRUSTED_START_MARKER)) return data; // Avoid double wrapping
  return `${UNTRUSTED_START_MARKER}\n${data}\n${UNTRUSTED_END_MARKER}`;
}
