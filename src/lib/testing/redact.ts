const MIN_SENSITIVE_LENGTH = 4;

/**
 * Recursively redacts sensitive strings from arbitrary data structures (strings, objects, arrays).
 *
 * SAFETY INVARIANTS:
 * - Targets are sorted in strictly descending order by length (`b.length - a.length`).
 *   This prevents prefix truncation (e.g. "admin123" truncating "admin123456" into "******456").
 * - Strings under MIN_SENSITIVE_LENGTH (4) are excluded to prevent false-positive masking.
 * - Uses literal string splitting (`split(t).join("******")`) to avoid RegExp special-character escape issues.
 */
export function redactSensitiveData<T>(data: T, sensitiveValues: Set<string>): T {
  if (!sensitiveValues || sensitiveValues.size === 0 || data === null || data === undefined) {
    return data;
  }

  // Filter valid targets and sort by descending length (longest first)
  const targets = Array.from(sensitiveValues)
    .filter((s) => typeof s === "string" && s.length >= MIN_SENSITIVE_LENGTH)
    .sort((a, b) => b.length - a.length);

  if (targets.length === 0) {
    return data;
  }

  function walk(node: unknown): unknown {
    if (typeof node === "string") {
      let text = node;
      for (const secret of targets) {
        text = text.split(secret).join("******");
      }
      return text;
    }

    if (Array.isArray(node)) {
      return node.map(walk);
    }

    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }

    return node;
  }

  return walk(data) as T;
}

export interface RedactableError {
  source: string;
  message: string;
  stack?: string;
  details?: unknown;
}

/**
 * Redacts message, stack, details and any nested string fields in a structured ErrorEnvelope.
 */
export function redactErrorEnvelope<E extends RedactableError | null | undefined>(
  error: E,
  sensitiveValues: Set<string>,
): E {
  if (!error) return error;
  return redactSensitiveData(error, sensitiveValues);
}
