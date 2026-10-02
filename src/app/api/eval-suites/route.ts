import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getConfigNumber } from "@/lib/config";
import {
  CONFIG_KEY_TARGET_TIMEOUT,
  DEFAULT_EVAL_TARGET_TIMEOUT_S,
} from "@/lib/evaluation/config";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import { isAgentVisibleTo } from "@/lib/access/agent-visibility";
import { suiteVariablesSchema } from "@/lib/testing/variables-schema";
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
    threshold: z.number().int().min(1).max(5).optional(),
    targetTimeoutSec: z.number().int().min(1).max(3600).optional().nullable(),
    dimensionIds: z.array(z.string()).optional(),
    variables: suiteVariablesSchema.optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  // SECURITY: Target agent must be visible to the creator when source is builtin.
  const agentSource = body.agentSource ?? "builtin";
  if (agentSource === "builtin") {
    const targetVisible = await isAgentVisibleTo(body.agentId, session.user.id);
    if (!targetVisible) {
      throw new ApiError("NOT_FOUND", 404, "Target agent not found.");
    }
  }

  // SECURITY: Evaluator agent must be visible to the creator if specified.
  if (body.evaluatorAgentId) {
    const evalVisible = await isAgentVisibleTo(body.evaluatorAgentId, session.user.id);
    if (!evalVisible) {
      throw new ApiError("NOT_FOUND", 404, "Evaluator agent not found.");
    }
  }

  const defaultTargetTimeout = getConfigNumber(
    CONFIG_KEY_TARGET_TIMEOUT,
    DEFAULT_EVAL_TARGET_TIMEOUT_S,
  );
  const resolvedTargetTimeoutSec =
    typeof body.targetTimeoutSec === "number" && body.targetTimeoutSec > 0
      ? body.targetTimeoutSec
      : defaultTargetTimeout;

  try {
    const row = await storage.createSuite({
      ...body,
      targetTimeoutSec: resolvedTargetTimeoutSec,
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
