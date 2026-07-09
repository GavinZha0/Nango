import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
} from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
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
    dimensionIds: z.array(z.string()).optional(),
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
      body.dimensionIds !== undefined;

    if (contentEdit && !canEditResource(rbac, session)) {
      throw new ApiError("FORBIDDEN", 403, "You cannot edit this eval suite.");
    }

    const flagEdit =
      body.enabled !== undefined ||
      body.visibility !== undefined;

    if (flagEdit && !canChangeVisibility(rbac, session)) {
      throw new ApiError("FORBIDDEN", 403, "Only the creator or admin can change visibility / enabled.");
    }

    try {
      const updated = await storage.updateSuite(suite.id, body, session.user.id);
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
