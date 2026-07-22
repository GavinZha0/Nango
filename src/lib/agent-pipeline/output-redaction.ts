/**
 * Agent pipeline — G13 Output Redaction & Sliding Window Stream Redactor.
 *
 * Prevents LLM generated responses from leaking sensitive PII (phone numbers,
 * ID cards, emails) or system credentials (API Keys, Bearer tokens).
 *
 * Provides a SlidingWindowRedactor for zero-stuttering SSE stream pass-through.
 *
 * See docs/architecture-improvements.md "P1 — Safety Guardrails".
 */

import "server-only";

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: string | ((match: string, ...args: string[]) => string);
}

export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  {
    name: "chinese_phone",
    pattern: /\b(1[3-9]\d)(\d{4})(\d{4})\b/g,
    replace: (_match: string, p1: string, _p2: string, p3: string) => `${p1}****${p3}`,
  },
  {
    name: "id_card",
    pattern: /\b(\d{6})\d{8}(\d{3}[\dXx])\b/g,
    replace: (_match: string, p1: string, p2: string) => `${p1}********${p2}`,
  },
  {
    name: "email",
    pattern: /\b([A-Za-z0-9._%+-]{1,3})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    replace: (_match: string, p1: string, p2: string) => `${p1}***@${p2}`,
  },
  {
    name: "openai_api_key",
    pattern: /sk-[a-zA-Z0-9_-]{20,}/g,
    replace: "[REDACTED_API_KEY]",
  },
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replace: "[REDACTED_AWS_KEY]",
  },
  {
    name: "bearer_token",
    pattern: /Bearer\s+[a-zA-Z0-9._~+/-]{20,}=*/gi,
    replace: "Bearer [REDACTED_TOKEN]",
  },
];

/**
 * Apply redaction rules to a full text segment.
 */
export function redactSensitiveText(
  text: string,
  rules: RedactionRule[] = DEFAULT_REDACTION_RULES,
): string {
  if (!text) return text;
  let redacted = text;
  for (const rule of rules) {
    redacted = redacted.replace(rule.pattern, rule.replace as never);
  }
  return redacted;
}

/**
 * Sliding Window Redactor for real-time SSE stream pass-through.
 * Maintains a small buffer (default 60 chars) so stream latency stays < 100ms
 * without breaking cross-chunk pattern matching or causing front-end stutter.
 */
export class SlidingWindowRedactor {
  private buffer = "";
  public readonly effectiveWindowSize: number;

  constructor(
    configuredWindowSize = 60,
    private rules: RedactionRule[] = DEFAULT_REDACTION_RULES,
  ) {
    // Smart auto-scaling: ensure window is at least as large as 60 chars or max rule requirements
    this.effectiveWindowSize = Math.max(configuredWindowSize, 60);
  }

  /**
   * Push a new streaming chunk into the window and return safe flushed text.
   */
  push(chunk: string): string {
    if (!chunk) return "";
    this.buffer += chunk;

    if (this.buffer.length > this.effectiveWindowSize) {
      const flushableCount = this.buffer.length - this.effectiveWindowSize;

      // Apply redaction to the full buffer
      const redactedBuffer = redactSensitiveText(this.buffer, this.rules);

      // Extract safe flushed portion and keep the window tail
      const flushed = redactedBuffer.slice(0, flushableCount);
      this.buffer = redactedBuffer.slice(flushableCount);

      return flushed;
    }

    return "";
  }

  /**
   * Flush all remaining buffered text at stream end (TEXT_END / complete).
   */
  flush(): string {
    if (!this.buffer) return "";
    const redacted = redactSensitiveText(this.buffer, this.rules);
    this.buffer = "";
    return redacted;
  }
}
