import "server-only";

import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "testing-tools" });

/**
 * Normalizes input that may have been stringified by an LLM function-calling
 * serializer into its parsed JSON representation (object or array).
 * Returns the original value if it is not a JSON string.
 */
export function jsonOrSelf(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch (err) {
        log.debug(
          {
            err,
            snippet: trimmed.slice(0, 150),
          },
          "jsonOrSelf failed to parse candidate JSON string; falling back to original value",
        );
        return val;
      }
    }
  }
  return val;
}
