import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfigNumber } from "@/lib/config";
import {
  CONFIG_KEY_TARGET_TIMEOUT,
  DEFAULT_EVAL_TARGET_TIMEOUT_S,
} from "@/lib/evaluation/config";
import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
} from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import { isAgentVisibleTo } from "@/lib/access/agent-visibility";
import { suiteVariablesSchema } from "@/lib/testing/variables-schema";
import { loadSuite } from "@/lib/evaluation/access";
import * as storage from "@/lib/evaluation/storage";

const ROUTE = "/api/eval-suites/[id]";

// GET /api/eval-suites/[id]

export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadSuite(params.id, session);
    const caseCount = await storage.getCaseCount(suite.id);
    return NextResponse.json({ ...suite, caseCount });
  },
);

// PATCH /api/eval-suites/[id]

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional().nullable(),
    evaluatorAgentId: z.string().uuid().optional().nullable(),
    threshold: z.number().int().min(1).max(5).optional(),
    targetTimeoutSec: z.number().int().min(1).max(3600).optional().nullable(),
    dimensionIds: z.array(z.string()).optional(),
    variables: suiteVariablesSchema.optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const suite = await loadSuite(params.id, session);

    const rbac = {
      visibility: suite.visibility as "private" | "public",
      createdBy: suite.createdBy,
    };

    const contentEdit =
      body.name !== undefined ||
      body.description !== undefined ||
      body.evaluatorAgentId !== undefined ||
      body.threshold !== undefined ||
      body.targetTimeoutSec !== undefined ||
      body.dimensionIds !== undefined ||
      body.variables !== undefined;

    if (contentEdit && !canEditResource(rbac, session)) {
      throw new ApiError("FORBIDDEN", 403, "You cannot edit this eval suite.");
    }

    const flagEdit =
      body.enabled !== undefined ||
      body.visibility !== undefined;

    if (flagEdit && !canChangeVisibility(rbac, session)) {
      throw new ApiError("FORBIDDEN", 403, "Only the creator or admin can change visibility / enabled.");
    }

    // SECURITY: Evaluator agent must be visible if updated.
    if (body.evaluatorAgentId) {
      const evalVisible = await isAgentVisibleTo(body.evaluatorAgentId, session.user.id);
      if (!evalVisible) {
        throw new ApiError("NOT_FOUND", 404, "Evaluator agent not found.");
      }
    }

    let targetTimeoutSecToSave: number | undefined;
    if (body.targetTimeoutSec !== undefined) {
      const defaultTargetTimeout = getConfigNumber(
        CONFIG_KEY_TARGET_TIMEOUT,
        DEFAULT_EVAL_TARGET_TIMEOUT_S,
      );
      targetTimeoutSecToSave =
        typeof body.targetTimeoutSec === "number" && body.targetTimeoutSec > 0
          ? body.targetTimeoutSec
          : defaultTargetTimeout;
    }

    try {
      const updated = await storage.updateSuite(
        suite.id,
        {
          ...body,
          ...(targetTimeoutSecToSave !== undefined
            ? { targetTimeoutSec: targetTimeoutSecToSave }
            : {}),
        },
        session.user.id,
      );
      const caseCount = await storage.getCaseCount(suite.id);
      return NextResponse.json({ ...updated, caseCount });
    } catch (err) {
      if (isUniqueViolation(err) && body.name) {
        throw new ApiError(
          "CONFLICT",
          409,
          `An eval suite named "${body.name}" already exists for this agent.`,
        );
      }
      throw err;
    }
  },
);

// DELETE /api/eval-suites/[id]

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadSuite(params.id, session);
    const rbac = {
      visibility: suite.visibility as "private" | "public",
      createdBy: suite.createdBy,
    };
    if (!canDeleteResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this eval suite.",
      );
    }
    await storage.deleteSuite(suite.id);
    return new NextResponse(null, { status: 204 });
  },
);
