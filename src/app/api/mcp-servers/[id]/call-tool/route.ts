import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor } from "@/lib/http/route-handlers";
import { nonEmptyString, parseBody } from "@/lib/http/validation";
import { withMcpAdminClient } from "@/lib/mcp/admin-client.server";

export const dynamic = "force-dynamic";

const callToolSchema = z.object({
  toolName: nonEmptyString,
  args: z.record(z.string(), z.unknown()).optional(),
});

/**
 * tryParseJson — best-effort JSON.parse with a typed fallback.
 *
 * Only attempts to parse when the input looks like a JSON object or array
 * (starts with `{`/`[` and ends with the matching brace). Plain strings,
 * ISO timestamps, numeric strings, etc. are returned untouched so they
 * don't get mangled into their parsed primitive form.
 */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const looksLikeJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!looksLikeJson) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * normalizeToolResult — post-process the raw MCP CallToolResult so the test
 * page can render structured JSON instead of a single long string.
 *
 * MCP servers return `{ content: [{ type: "text", text: "<JSON string>" }, …] }`
 * — the `text` field is always a string, even when its payload is a JSON
 * document. The MCP test page uses `JsonView`, which renders strings as a
 * single line (now click-to-expand, but still a flat string). To get a
 * proper tree view we mirror ChatPie's behaviour: walk `content[]`, and for
 * every `{type: "text", text: "<looks like JSON>"}` element, replace `text`
 * with the parsed value. Non-JSON text and non-text content (image, etc.)
 * pass through unchanged.
 */
interface McpTextContent {
  type: "text";
  text: string;
}
interface McpContentEntry {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

function normalizeToolResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as { content?: unknown };
  if (!Array.isArray(obj.content)) return raw;

  return {
    ...obj,
    content: (obj.content as McpContentEntry[]).map((entry) => {
      if (entry?.type === "text" && typeof entry.text === "string") {
        const parsed = tryParseJson(entry.text);
        const normalized: McpTextContent | { type: "text"; text: unknown } = {
          type: "text",
          text: parsed,
        };
        return normalized;
      }
      return entry;
    }),
  };
}

/**
 * POST /api/mcp-servers/[id]/call-tool
 */
export const POST = withEditor<{ id: string }>(
  "/api/mcp-servers/[id]/call-tool",
  async ({ req, params }) => {
    const body = await parseBody(req, callToolSchema);
    const raw = await withMcpAdminClient({
      serverId: params.id,
      clientName: "nango-tool-call",
      errorPrefix: "Tool call failed",
      fn: ({ client }) =>
        client.callTool({
          name: body.toolName,
          arguments: body.args ?? {},
        }),
    });
    return NextResponse.json({ result: normalizeToolResult(raw) });
  },
);
