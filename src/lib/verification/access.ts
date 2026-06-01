/**
 * Verification — API-layer access helpers.
 *
 * "Load + visibility-check" wrappers used by every route handler.
 * Keeping them here (rather than inlined in each route.ts) prevents
 * the 8 routes from drifting on the "is this row visible to this
 * caller?" semantics.
 *
 * Returns the row on success; throws {@link ApiError} 404 on missing
 * or hidden so private ids stay opaque (matches the skills / mcp /
 * agent route convention).
 */

import "server-only";

import { z } from "zod";

import { canViewResource } from "@/lib/auth/permissions";
import { ApiError, type Session } from "@/lib/http/route-handlers";
import type {
  VerificationCaseEntity,
  VerificationSuiteEntity,
} from "@/lib/db/schema";

import * as storage from "./storage";

/** Catch malformed path params BEFORE they reach drizzle / Postgres
 *  (which would raise `22P02` and surface as an unhandled 500). Surfaces
 *  the same opaque NOT_FOUND envelope as a real miss so private suite ids
 *  stay opaque. Centralised here so every route handler benefits without
 *  repeating the check. */
const suiteIdSchema = z.string().uuid();

export async function loadVisibleSuite(
  suiteId: string,
  session: Session,
): Promise<VerificationSuiteEntity> {
  if (!suiteIdSchema.safeParse(suiteId).success) {
    throw new ApiError("NOT_FOUND", 404, "Verification suite not found.");
  }
  const row = await storage.getSuiteById(suiteId);
  if (!row) {
    throw new ApiError("NOT_FOUND", 404, "Verification suite not found.");
  }
  if (
    !canViewResource(
      {
        visibility: row.visibility as "private" | "public",
        createdBy: row.createdBy,
      },
      session,
    )
  ) {
    throw new ApiError("NOT_FOUND", 404, "Verification suite not found.");
  }
  return row;
}

export interface VisibleCase {
  caseRow: VerificationCaseEntity;
  suite: VerificationSuiteEntity;
}

/** A case is visible iff its owning suite is. */
export async function loadVisibleCase(
  caseId: number,
  session: Session,
): Promise<VisibleCase> {
  const caseRow = await storage.getCaseById(caseId);
  if (!caseRow) {
    throw new ApiError("NOT_FOUND", 404, "Verification case not found.");
  }
  const suite = await storage.getSuiteById(caseRow.suiteId);
  if (!suite) {
    throw new ApiError("NOT_FOUND", 404, "Verification case not found.");
  }
  if (
    !canViewResource(
      {
        visibility: suite.visibility as "private" | "public",
        createdBy: suite.createdBy,
      },
      session,
    )
  ) {
    throw new ApiError("NOT_FOUND", 404, "Verification case not found.");
  }
  return { caseRow, suite };
}
