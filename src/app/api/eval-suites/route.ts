import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import * as storage from "@/lib/evaluation/storage";

const ROUTE = "/api/eval-suites";

// GET /api/eval-suites[?agentId=<id>&agentSource=builtin]
// Returns suites visible to the user (optionally filtered by agent).

export const GET = withEditor(ROUTE, async ({ req, session }) => {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  const agentSource = url.searchParams.get("agentSource");

  const rows = await storage.listSuitesByAgentWithCaseCount(
    agentId,
    agentSource,
    session,
  );
  return NextResponse.json(rows);
});

// POST /api/eval-suites

const createSchema = z
  .object({
    agentId: z.string().min(1),
    agentSource: z.enum(["builtin", "backend"]).optional(),
    credentialId: z.string().uuid().optional().nullable(),
    evaluatorAgentId: z.string().uuid().optional().nullable(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    dimensionIds: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  try {
    const row = await storage.createSuite({
      ...body,
      createdBy: session.user.id,
    });
    return NextResponse.json({ ...row, caseCount: 0 }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        "CONFLICT",
        409,
        `An eval suite named "${body.name}" already exists for this agent.`,
      );
    }
    throw err;
  }
});
