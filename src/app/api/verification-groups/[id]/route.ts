import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-groups/[id]";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();

// PATCH /api/verification-groups/[id]
// Renames an existing verification group.
export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params }) => {
    const body = await parseBody(req, patchSchema);

    try {
      const updated = await storage.renameGroup(params.id, body.name);
      return NextResponse.json(updated);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(
          "CONFLICT",
          409,
          `A group named "${body.name}" already exists.`,
        );
      }
      throw err;
    }
  },
);
