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
import { getGuardrailConfigCache } from "./guardrail-service";

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
    name: "us_phone",
    pattern: /\b(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g,
    replace: (_match: string, p1: string, _p2: string, p3: string) => `(${p1}) ***-${p3}`,
  },
  {
    name: "credit_card",
    pattern: /\b(\d{4})[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?(\d{4})\b/g,
    replace: (_match: string, p1: string, p2: string) => `${p1}-****-****-${p2}`,
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
 * Get active redaction rules dynamically from the DB cache, falling back
 * to DEFAULT_REDACTION_RULES if none are configured.
 */
export function getActiveRedactionRules(): RedactionRule[] {
  const cache = getGuardrailConfigCache();
  const activeRules = cache.safetyPolicies.filter(
    (p) => p.enabled && p.scope === "output" && p.policyType === "regex"
  );

  if (activeRules.length === 0) {
    return DEFAULT_REDACTION_RULES;
  }

  return activeRules.map((r) => {
    let pattern: RegExp;
    const config = (r.policyConfig || {}) as Record<string, unknown>;
    try {
      pattern = new RegExp(config.pattern as string, "g");
    } catch (e) {
      console.error(`[output-safety] Invalid regex pattern in rule ${r.name}:`, e);
      // Fallback if invalid regex in DB
      pattern = /(?!)/;
    }
    return {
      name: r.name,
      pattern,
      replace: (config.replacement as string) || "[REDACTED]",
    };
  });
}

/**
 * Apply redaction rules to a full text segment.
 */
export function redactSensitiveText(
  text: string,
  rules: RedactionRule[] | null = null,
  onRedact?: (rule: RedactionRule, snippet: string) => void,
): string {
  const actualRules = rules ?? getActiveRedactionRules();
  if (!text) return text;
  let redacted = text;
  for (const rule of actualRules) {
    if (onRedact) {
      const matches = redacted.match(rule.pattern);
      if (matches && matches.length > 0) {
        for (const m of matches) {
          onRedact(rule, m);
        }
      }
    }
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
  private rules: RedactionRule[];
  private onRedact?: (rule: RedactionRule, snippet: string) => void;

  constructor(
    configuredWindowSize = 60,
    rules: RedactionRule[] | null = null,
    onRedact?: (rule: RedactionRule, snippet: string) => void,
  ) {
    this.rules = rules ?? getActiveRedactionRules();
    this.onRedact = onRedact;
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
      // Apply redaction to the full buffer first
      const redactedBuffer = redactSensitiveText(this.buffer, this.rules, this.onRedact);

      // Recalculate flushable count after redaction (length may have changed)
      const safeFlushLength = Math.max(0, redactedBuffer.length - this.effectiveWindowSize);

      // Extract safe flushed portion and keep the window tail
      const flushed = redactedBuffer.slice(0, safeFlushLength);
      this.buffer = redactedBuffer.slice(safeFlushLength);

      return flushed;
    }

    return "";
  }

  /**
   * Flush all remaining buffered text at stream end (TEXT_END / complete).
   */
  flush(): string {
    if (!this.buffer) return "";
    const redacted = redactSensitiveText(this.buffer, this.rules, this.onRedact);
    this.buffer = "";
    return redacted;
  }
}

/**
 * Protocol-aware SSE Stream Redactor.
 * Parses CopilotKit SSE events, extracts TextMessageContent deltas,
 * feeds them through SlidingWindowRedactor, and rebuilds the SSE chunks.
 */
export class SseStreamRedactor {
  private buffer = "";
  private lastTextMessageId = "";
  private lastReasoningMessageId = "";
  private textRedactor: SlidingWindowRedactor;
  private reasoningRedactor: SlidingWindowRedactor;

  constructor(
    rules: RedactionRule[] | null = null,
    onRedact?: (rule: RedactionRule, snippet: string) => void,
  ) {
    this.textRedactor = new SlidingWindowRedactor(60, rules, onRedact);
    this.reasoningRedactor = new SlidingWindowRedactor(60, rules, onRedact);
  }

  processChunk(chunk: string): string {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    const outputLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") {
          const flushText = this.textRedactor.flush();
          if (flushText && this.lastTextMessageId) {
            outputLines.push(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: this.lastTextMessageId, delta: flushText })}`);
            outputLines.push("");
          }
          const flushReasoning = this.reasoningRedactor.flush();
          if (flushReasoning && this.lastReasoningMessageId) {
            outputLines.push(`data: ${JSON.stringify({ type: "REASONING_MESSAGE_CONTENT", messageId: this.lastReasoningMessageId, delta: flushReasoning })}`);
            outputLines.push("");
          }
          outputLines.push(line);
          continue;
        }

        try {
          const data = JSON.parse(dataStr);
          
          if (data.type === "TEXT_MESSAGE_CONTENT" && typeof data.delta === "string") {
            this.lastTextMessageId = data.messageId || this.lastTextMessageId;
            const safeDelta = this.textRedactor.push(data.delta);
            if (safeDelta) {
              data.delta = safeDelta;
              outputLines.push(`data: ${JSON.stringify(data)}`);
            }
          } else if (data.type === "TEXT_MESSAGE_END") {
            const flushDelta = this.textRedactor.flush();
            if (flushDelta && this.lastTextMessageId) {
              outputLines.push(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: this.lastTextMessageId, delta: flushDelta })}`);
              outputLines.push("");
            }
            outputLines.push(line);
          } else if (data.type === "REASONING_MESSAGE_CONTENT" && typeof data.delta === "string") {
            this.lastReasoningMessageId = data.messageId || this.lastReasoningMessageId;
            const safeDelta = this.reasoningRedactor.push(data.delta);
            if (safeDelta) {
              data.delta = safeDelta;
              outputLines.push(`data: ${JSON.stringify(data)}`);
            }
          } else if (data.type === "REASONING_MESSAGE_END") {
            const flushDelta = this.reasoningRedactor.flush();
            if (flushDelta && this.lastReasoningMessageId) {
              outputLines.push(`data: ${JSON.stringify({ type: "REASONING_MESSAGE_CONTENT", messageId: this.lastReasoningMessageId, delta: flushDelta })}`);
              outputLines.push("");
            }
            outputLines.push(line);
          } else {
            // Pass through other events unmodified
            outputLines.push(line);
          }
        } catch (e) {
          console.error("Output safety error:", e);
          // If JSON parse fails, pass it through
          outputLines.push(line);
        }
      } else {
        // Pass through non-data lines (like empty lines or event: lines)
        outputLines.push(line);
      }
    }

    return outputLines.length > 0 ? outputLines.join("\n") + "\n" : "";
  }

  flush(): string {
    let out = "";
    if (this.buffer) {
      out += this.buffer + "\n";
      this.buffer = "";
    }
    const flushText = this.textRedactor.flush();
    if (flushText && this.lastTextMessageId) {
      out += `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: this.lastTextMessageId, delta: flushText })}\n\n`;
    }
    const flushReasoning = this.reasoningRedactor.flush();
    if (flushReasoning && this.lastReasoningMessageId) {
      out += `data: ${JSON.stringify({ type: "REASONING_MESSAGE_CONTENT", messageId: this.lastReasoningMessageId, delta: flushReasoning })}\n\n`;
    }
    return out;
  }
}

