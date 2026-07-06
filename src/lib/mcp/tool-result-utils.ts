/**
 * Unified utility for processing MCP tool results.
 * Handles deduplication of massive JSON payloads that are redundantly sent in both
 * `content[0].text` and `structuredContent` by some MCP servers for backward compatibility.
 * 
 * Also optionally parses stringified JSON into real JS objects so that UI components
 * (like JsonView in the test page) can render them as interactive trees.
 */
export function normalizeMcpToolResult(
  raw: unknown,
  options: { parseForUi: boolean }
): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as { content?: unknown; structuredContent?: unknown };
  if (!Array.isArray(obj.content)) return raw;

  return {
    ...obj,
    content: obj.content.map((entry: { type?: string; text?: unknown; [key: string]: unknown }) => {
      if (entry?.type === "text") {
        let parsed = entry.text;
        const isObjectOriginally = typeof entry.text === "object" && entry.text !== null;
        let isParsedFromJsonString = false;

        if (!isObjectOriginally && typeof entry.text === "string") {
          const trimmed = entry.text.trim();
          const looksLikeJson =
            (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
            (trimmed.startsWith("[") && trimmed.endsWith("]"));

          if (looksLikeJson) {
            try {
              parsed = JSON.parse(trimmed);
              isParsedFromJsonString = true;
            } catch {
              // Ignore invalid JSON
            }
          }
        }

        // If structuredContent is present AND the text is essentially JSON, it's redundant.
        const isRedundant = obj.structuredContent !== undefined && (isObjectOriginally || isParsedFromJsonString);

        if (isRedundant) {
          return {
            ...entry,
            text: `Refer to 'structuredContent' field for the full JSON payload.`,
          };
        }

        // If we didn't deduplicate it (e.g. structuredContent is missing), but we want to render it nicely in the UI
        if (options.parseForUi && isParsedFromJsonString) {
          return {
            ...entry,
            text: parsed,
          };
        }
      }
      return entry;
    }),
  };
}

/**
 * Legacy wrapper for backward compatibility with external references.
 */
export function normalizeAndDeduplicateMcpResult(
  raw: unknown,
  options: { parseForUi: boolean }
): unknown {
  return normalizeMcpToolResult(raw, options);
}

