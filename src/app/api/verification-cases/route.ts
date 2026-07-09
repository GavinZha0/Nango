import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { VerificationCaseTable, VerificationSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import {
  assertionsArraySchema,
  caseInputSchema,
} from "@/lib/verification/wire-schemas";

const ROUTE = "/api/verification-cases";

const mcpCaseSchema = z.object({
  mcpServerId: z.string().uuid(),
  toolName: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(120),
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
    const { mcpServerId, toolName } = body;

    // 1. Find if a suite already exists for this mcpServerId & toolName
    const [existingSuite] = await db
      .select()
      .from(VerificationSuiteTable)
      .where(
        and(
          eq(VerificationSuiteTable.mcpServerId, mcpServerId),
          eq(VerificationSuiteTable.toolName, toolName),
          eq(VerificationSuiteTable.createdBy, session.user.id),
        )
      )
      .limit(1);

    if (existingSuite) {
      suiteId = existingSuite.id;
    } else {
      // 2. If not, auto-create a suite on-the-fly
      const [newSuite] = await db
        .insert(VerificationSuiteTable)
        .values({
          name: toolName, // Automatically name the suite after the tool
          description: `Automatically created verification suite for tool ${toolName}`,
          category: "mcp",
          mcpServerId,
          toolName,
          visibility: "private",
          createdBy: session.user.id,
          updatedBy: session.user.id,
        })
        .returning();
      suiteId = newSuite.id;
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
        name: body.name,
        input: body.input ?? {},
        assertions: (body.assertions ?? []) as unknown,
        enabled: body.enabled ?? true,
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
      toolName: suiteRow?.toolName ?? null,
    };

    return NextResponse.json(responseRow, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        "CONFLICT",
        409,
        `A case named "${body.name}" already exists for this tool.`,
      );
    }
    throw err;
  }
});
