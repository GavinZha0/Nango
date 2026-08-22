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

import { normalizeMcpToolResult } from "@/lib/mcp/tool-result-utils";

import { getConfigMs, getConfigNumber } from "@/lib/config";

const DEFAULT_EXECUTION_TIMEOUT_S = 60;

/**
 * POST /api/mcp-servers/[id]/call-tool
 */
export const POST = withEditor<{ id: string }>(
  "/api/mcp-servers/[id]/call-tool",
  async ({ req, params }) => {
    const body = await parseBody(req, callToolSchema);
    const timeoutMs = getConfigMs(
      "mcp.execution_timeout",
      DEFAULT_EXECUTION_TIMEOUT_S,
    );
    const raw = await withMcpAdminClient({
      serverId: params.id,
      clientName: "nango-tool-call",
      errorPrefix: "Tool call failed",
      fn: ({ client }) =>
        client.callTool(
          {
            name: body.toolName,
            arguments: body.args ?? {},
          },
          undefined,
          { timeout: timeoutMs },
        ),
    });
    return NextResponse.json({
      result: normalizeMcpToolResult(raw, { parseForUi: true }),
      snapshotMaxBytes: getConfigNumber("mcp.test_snapshot_max_kb", 32) * 1024,
    });
  },
);
