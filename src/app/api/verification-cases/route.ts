import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { VerificationCaseTable, VerificationSuiteTable, McpServerTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import {
  assertionsArraySchema,
  caseInputSchema,
} from "@/lib/verification/wire-schemas";
import { normalizeCaseName } from "@/lib/verification/resolve-input";

const ROUTE = "/api/verification-cases";

const mcpCaseSchema = z.object({
  mcpServerId: z.string().uuid(),
  toolName: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(120),
  suiteId: z.string().uuid().optional(),
  input: caseInputSchema.optional(),
  assertions: assertionsArraySchema.optional(),
  enabled: z.boolean().optional(),
});

const workflowCaseSchema = z.object({
  workflowId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  input: caseInputSchema.optional(),
  assertions: assertionsArraySchema.optional(),
  enabled: z.boolean().optional(),
});

const createSchema = z.union([mcpCaseSchema, workflowCaseSchema]);

// POST /api/verification-cases
// Unified endpoint to create a case. Handles backend-level lazy suite creation.
export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);
  const isMcp = "mcpServerId" in body;

  let suiteId: string;

  if (isMcp) {
    const { mcpServerId, suiteId: reqSuiteId } = body as z.infer<typeof mcpCaseSchema>;

    if (reqSuiteId) {
      suiteId = reqSuiteId;
    } else {
      // 1. Find if a suite already exists for this mcpServerId
      const [existingSuite] = await db
        .select()
        .from(VerificationSuiteTable)
        .where(
          and(
            eq(VerificationSuiteTable.mcpServerId, mcpServerId),
            eq(VerificationSuiteTable.createdBy, session.user.id),
          )
        )
        .limit(1);

      if (existingSuite) {
        suiteId = existingSuite.id;
      } else {
      // Try to fetch server title/name for suite name
      const [server] = await db
        .select({ name: McpServerTable.name, serverTitle: McpServerTable.serverTitle })
        .from(McpServerTable)
        .where(eq(McpServerTable.id, mcpServerId))
        .limit(1);

      const serverName = server?.serverTitle || server?.name || "MCP Server";
      const suiteName = `${serverName} Suite`;

      // 2. If not, auto-create a suite on-the-fly
      const [newSuite] = await db
        .insert(VerificationSuiteTable)
        .values({
          name: suiteName,
          description: `Automatically created verification suite for ${serverName}`,
          category: "mcp",
          mcpServerId,
          visibility: "private",
          createdBy: session.user.id,
          updatedBy: session.user.id,
        })
        .returning();
      suiteId = newSuite.id;
      }
    }
  } else {
    // Workflow validation is coming in V2, but we placeholder the lazy-suite creation here.
    const { workflowId } = body;
    const [existingSuite] = await db
      .select()
      .from(VerificationSuiteTable)
      .where(
        and(
          eq(VerificationSuiteTable.workflowId, workflowId),
          eq(VerificationSuiteTable.createdBy, session.user.id),
        )
      )
      .limit(1);

    if (existingSuite) {
      suiteId = existingSuite.id;
    } else {
      const [newSuite] = await db
        .insert(VerificationSuiteTable)
        .values({
          name: `workflow-${workflowId}`,
          description: `Automatically created verification suite for workflow ${workflowId}`,
          category: "workflow",
          workflowId,
          visibility: "private",
          createdBy: session.user.id,
          updatedBy: session.user.id,
        })
        .returning();
      suiteId = newSuite.id;
    }
  }

  // 3. Write verification case
  try {
    const [row] = await db
      .insert(VerificationCaseTable)
      .values({
        suiteId,
        name: normalizeCaseName(body.name),
        toolName: isMcp ? (body as z.infer<typeof mcpCaseSchema>).toolName : null,
        input: body.input ?? {},
        assertions: (body.assertions ?? []) as unknown,
        enabled: body.enabled ?? true,
        createdBy: session.user.id,
      })
      .returning();

    // Join with suite to get mcpServerId for the response
    const [suiteRow] = await db
      .select()
      .from(VerificationSuiteTable)
      .where(eq(VerificationSuiteTable.id, row.suiteId))
      .limit(1);

    const responseRow = {
      ...row,
      mcpServerId: suiteRow?.mcpServerId ?? null,
      toolName: row.toolName ?? null,
    };

    return NextResponse.json(responseRow, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        "CONFLICT",
        409,
        `A case named "${normalizeCaseName(body.name)}" already exists in this suite.`,
      );
    }
    throw err;
  }
});
