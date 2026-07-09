/** Evaluation — API-layer access helpers. See docs/evaluation.md. */

import "server-only";

import { z } from "zod";
import { canViewResource } from "@/lib/auth/permissions";
import { ApiError, type Session } from "@/lib/http/route-handlers";
import type { EvalCaseEntity, EvalSuiteEntity } from "@/lib/db/schema";

import * as storage from "./storage";

const suiteIdSchema = z.string().uuid();

export async function loadSuite(
  suiteId: string,
  session: Session,
): Promise<EvalSuiteEntity> {
  if (!suiteIdSchema.safeParse(suiteId).success) {
    throw new ApiError("NOT_FOUND", 404, "Eval suite not found.");
  }
  const row = await storage.getSuiteById(suiteId);
  if (!row) {
    throw new ApiError("NOT_FOUND", 404, "Eval suite not found.");
  }
  // SECURITY: unified visibility check - admin sees all, others see
  // public suites + own private suites.
  if (!canViewResource({ visibility: row.visibility as "public" | "private", createdBy: row.createdBy }, session)) {
    throw new ApiError("NOT_FOUND", 404, "Eval suite not found.");
  }
  return row;
}

export interface VisibleCase {
  caseRow: EvalCaseEntity;
  suite: EvalSuiteEntity;
}

export async function loadCase(
  caseId: number,
  session: Session,
): Promise<VisibleCase> {
  const caseRow = await storage.getCaseById(caseId);
  if (!caseRow) {
    throw new ApiError("NOT_FOUND", 404, "Eval case not found.");
  }
  const suite = await storage.getSuiteById(caseRow.suiteId);
  if (!suite) {
    throw new ApiError("NOT_FOUND", 404, "Eval case not found.");
  }
  if (!canViewResource({ visibility: suite.visibility as "public" | "private", createdBy: suite.createdBy }, session)) {
    throw new ApiError("NOT_FOUND", 404, "Eval case not found.");
  }
  return { caseRow, suite };
}
