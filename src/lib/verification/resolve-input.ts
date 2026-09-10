/**
 * Re-export variable resolution utilities from the universal assertions module.
 *
 * See docs/verification.md.
 */

export {
  normalizeCaseName,
  resolveInput,
  substituteInputTemplates,
} from "@/lib/assertions";

const UNRESOLVED_TOKEN_RE = /\{\{\s*(cases\.[^{}]+?|\$[^{}]+?)\s*\}\}/g;

/**
 * Scan an object/string tree for unresolved template tokens (e.g. {{cases.010.output.xxx}} or {{$xxx}}).
 * Returns an array of unique unresolved token strings found.
 */
export function findUnresolvedTokens(node: unknown): string[] {
  const set = new Set<string>();

  function walk(val: unknown): void {
    if (typeof val === "string") {
      const matches = val.match(UNRESOLVED_TOKEN_RE);
      if (matches) {
        for (const m of matches) set.add(m.trim());
      }
    } else if (Array.isArray(val)) {
      for (const item of val) walk(item);
    } else if (val && typeof val === "object") {
      for (const v of Object.values(val as Record<string, unknown>)) {
        walk(v);
      }
    }
  }

  walk(node);
  return Array.from(set);
}

export { computeNextCasePrefix } from "./prefix";


/**
 * Extract structured business payload from a standard MCP CallToolResult.
 * Strictly adheres to MCP protocol: inspects structuredContent and content[0].text.
 * NEVER unwraps top-level 'result' property (which belongs to business data, unlike WebAuto).
 */
export function extractMcpStructuredData(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;

  const env = payload as { content?: unknown; structuredContent?: unknown };

  // 1. MCP structuredContent extension/standard
  if (env.structuredContent !== undefined && env.structuredContent !== null) {
    return env.structuredContent;
  }

  // 2. Standard MCP CallToolResult.content text entry
  if (Array.isArray(env.content) && env.content.length > 0) {
    for (const item of env.content) {
      if (
        item &&
        typeof item === "object" &&
        "type" in item &&
        item.type === "text" &&
        "text" in item
      ) {
        const text = item.text;
        if (typeof text === "object" && text !== null) return text;
        if (typeof text === "string") {
          const trimmed = text.trim();
          if (
            (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
            (trimmed.startsWith("[") && trimmed.endsWith("]"))
          ) {
            try {
              return JSON.parse(trimmed);
            } catch {
              // ignore invalid JSON
            }
          }
        }
      }
    }
  }

  // 3. Fallback: return payload as-is
  return payload;
}