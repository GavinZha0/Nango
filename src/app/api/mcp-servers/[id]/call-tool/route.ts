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

import { normalizeAndDeduplicateMcpResult } from "@/lib/mcp/tool-result-utils";

import { getConfigNumber } from "@/lib/config";

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
    return NextResponse.json({
      result: normalizeAndDeduplicateMcpResult(raw, { parseForUi: true }),
      snapshotMaxBytes: getConfigNumber("mcp.test_snapshot_max_kb", 24) * 1024,
    });
  },
);
