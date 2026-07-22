import "server-only";

import { db } from "@/lib/db";
import { eq, and, not, sql } from "drizzle-orm";
import {
  EntityRunTable,
  VerificationRunTable,
  VerificationSuiteTable,
  EvalRunTable,
  EvalSuiteTable,
  BuiltinAgentTable,
} from "@/lib/db/schema";

export interface ActiveTask {
  id: string;
  kind: "agent" | "verification" | "evaluation";
  name: string;
  status: "running" | "succeeded" | "failed";
  startedAt: Date;
  totalCount?: number;
  completedCount?: number;
}

export interface TaskProgressDetail {
  id: string;
  kind: "agent" | "verification" | "evaluation";
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  errorMessage?: string | null;
  progressText: string;
  summary?: string | null;
}

/**
 * 查询指定用户所有正在运行的后台任务（排除 schedule 定时任务）。
 * 供 Next.js API 路由与 Agent 服务端 Tools（如 Nango）共同调用。
 */
export async function getActiveTasks(ownerId: string): Promise<ActiveTask[]> {
  try {
    // 1. 查询正在运行的 Agent 异步任务
    const runningAgents = await db
      .select({
        id: EntityRunTable.id,
        entityId: EntityRunTable.entityId,
        entitySource: EntityRunTable.entitySource,
        entityKind: EntityRunTable.entityKind,
        startedAt: EntityRunTable.startedAt,
        createdAt: EntityRunTable.createdAt,
        builtinAgentName: BuiltinAgentTable.name,
      })
      .from(EntityRunTable)
      .leftJoin(
        BuiltinAgentTable,
        eq(EntityRunTable.entityId, sql`cast(${BuiltinAgentTable.id} as text)`)
      )
      .where(
        and(
          eq(EntityRunTable.ownerId, ownerId),
          eq(EntityRunTable.status, "running"),
          not(eq(EntityRunTable.initiator, "schedule")),
          not(eq(EntityRunTable.initiator, "evaluator"))
        )
      );

    const agentTasks: ActiveTask[] = runningAgents.map((row) => ({
      id: row.id,
      kind: "agent",
      name:
        row.entitySource === "builtin" && row.entityKind === "agent" && row.builtinAgentName
          ? row.builtinAgentName
          : row.entityId,
      status: "running",
      startedAt: row.startedAt ?? row.createdAt,
    }));

    // 2. 查询正在运行的 Verification Suite
    const runningVerifications = await db
      .select({
        id: VerificationRunTable.id,
        startedAt: VerificationRunTable.startedAt,
        totalCount: VerificationRunTable.totalCount,
        passedCount: VerificationRunTable.passedCount,
        failedCount: VerificationRunTable.failedCount,
        erroredCount: VerificationRunTable.erroredCount,
        skippedCount: VerificationRunTable.skippedCount,
        suiteName: VerificationSuiteTable.name,
      })
      .from(VerificationRunTable)
      .innerJoin(
        VerificationSuiteTable,
        eq(VerificationRunTable.suiteId, VerificationSuiteTable.id)
      )
      .where(
        and(
          eq(VerificationSuiteTable.createdBy, ownerId),
          eq(VerificationRunTable.status, "running")
        )
      );

    const verificationTasks: ActiveTask[] = runningVerifications.map((row) => ({
      id: row.id,
      kind: "verification",
      name: row.suiteName,
      status: "running",
      startedAt: row.startedAt,
      totalCount: row.totalCount,
      completedCount:
        row.passedCount +
        row.failedCount +
        row.erroredCount +
        row.skippedCount,
    }));

    // 3. 查询正在运行的 Evaluation Suite
    const runningEvaluations = await db
      .select({
        id: EvalRunTable.id,
        startedAt: EvalRunTable.startedAt,
        totalCount: EvalRunTable.totalCount,
        passedCount: EvalRunTable.passedCount,
        failedCount: EvalRunTable.failedCount,
        erroredCount: EvalRunTable.erroredCount,
        suiteName: EvalSuiteTable.name,
      })
      .from(EvalRunTable)
      .innerJoin(
        EvalSuiteTable,
        eq(EvalRunTable.suiteId, EvalSuiteTable.id)
      )
      .where(
        and(
          eq(EvalSuiteTable.createdBy, ownerId),
          eq(EvalRunTable.status, "running")
        )
      );

    const evaluationTasks: ActiveTask[] = runningEvaluations.map((row) => ({
      id: row.id,
      kind: "evaluation",
      name: row.suiteName,
      status: "running",
      startedAt: row.startedAt,
      totalCount: row.totalCount,
      completedCount: row.passedCount + row.failedCount + row.erroredCount,
    }));

    // 合并所有活跃任务并按照 startedAt 升序排列 (最早启动的排在前面)
    return [...agentTasks, ...verificationTasks, ...evaluationTasks].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime()
    );
  } catch (err) {
    console.error("getActiveTasks error:", err);
    return [];
  }
}

/**
 * 查询单个任务的执行状态、进度和结果。
 * 供 Agent 工具后续追踪特定任务结果并向用户汇报。
 *
 * SECURITY: scoped to the run's owner (`isAdmin` bypasses). agent runs
 * filter by `EntityRunTable.ownerId`; verification/evaluation runs have
 * no owner column, so they filter by the suite's `createdBy` — mirroring
 * `getActiveTasks`. Without this a caller could read any run by id.
 */
export async function getTaskProgress(
  runId: string,
  kind: "agent" | "verification" | "evaluation",
  userId: string,
  isAdmin = false
): Promise<TaskProgressDetail | null> {
  try {
    if (kind === "agent") {
      const [row] = await db
        .select({
          id: EntityRunTable.id,
          status: EntityRunTable.status,
          startedAt: EntityRunTable.startedAt,
          createdAt: EntityRunTable.createdAt,
          finishedAt: EntityRunTable.finishedAt,
          errorMessage: EntityRunTable.errorMessage,
          outputSummary: EntityRunTable.outputSummary,
        })
        .from(EntityRunTable)
        .where(
          isAdmin
            ? eq(EntityRunTable.id, runId)
            : and(eq(EntityRunTable.id, runId), eq(EntityRunTable.ownerId, userId))
        )
        .limit(1);

      if (!row) return null;
      return {
        id: row.id,
        kind: "agent",
        status: row.status,
        startedAt: row.startedAt ?? row.createdAt,
        finishedAt: row.finishedAt,
        errorMessage: row.errorMessage,
        progressText: row.status === "running" ? "Agent is working..." : `Agent run ${row.status}`,
        summary: row.outputSummary,
      };
    }

    if (kind === "verification") {
      const [row] = await db
        .select({
          id: VerificationRunTable.id,
          status: VerificationRunTable.status,
          startedAt: VerificationRunTable.startedAt,
          finishedAt: VerificationRunTable.finishedAt,
          totalCount: VerificationRunTable.totalCount,
          passedCount: VerificationRunTable.passedCount,
          failedCount: VerificationRunTable.failedCount,
          erroredCount: VerificationRunTable.erroredCount,
          skippedCount: VerificationRunTable.skippedCount,
          suiteName: VerificationSuiteTable.name,
        })
        .from(VerificationRunTable)
        .innerJoin(
          VerificationSuiteTable,
          eq(VerificationRunTable.suiteId, VerificationSuiteTable.id)
        )
        .where(
          isAdmin
            ? eq(VerificationRunTable.id, runId)
            : and(
                eq(VerificationRunTable.id, runId),
                eq(VerificationSuiteTable.createdBy, userId)
              )
        )
        .limit(1);

      if (!row) return null;
      const completed =
        row.passedCount +
        row.failedCount +
        row.erroredCount +
        row.skippedCount;
      return {
        id: row.id,
        kind: "verification",
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        progressText: `${completed}/${row.totalCount} cases completed (${row.passedCount} passed, ${row.failedCount} failed, ${row.erroredCount} errored)`,
        summary: `Verification Suite '${row.suiteName}' finished with status: ${row.status}.`,
      };
    }

    if (kind === "evaluation") {
      const [row] = await db
        .select({
          id: EvalRunTable.id,
          status: EvalRunTable.status,
          startedAt: EvalRunTable.startedAt,
          finishedAt: EvalRunTable.finishedAt,
          totalCount: EvalRunTable.totalCount,
          passedCount: EvalRunTable.passedCount,
          failedCount: EvalRunTable.failedCount,
          erroredCount: EvalRunTable.erroredCount,
          score: EvalRunTable.score,
          suiteName: EvalSuiteTable.name,
        })
        .from(EvalRunTable)
        .innerJoin(
          EvalSuiteTable,
          eq(EvalRunTable.suiteId, EvalSuiteTable.id)
        )
        .where(
          isAdmin
            ? eq(EvalRunTable.id, runId)
            : and(eq(EvalRunTable.id, runId), eq(EvalSuiteTable.createdBy, userId))
        )
        .limit(1);

      if (!row) return null;
      const completed = row.passedCount + row.failedCount + row.erroredCount;
      return {
        id: row.id,
        kind: "evaluation",
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        progressText: `${completed}/${row.totalCount} cases completed (${row.passedCount} passed, ${row.failedCount} failed, ${row.erroredCount} errored)`,
        summary: `Evaluation Suite '${row.suiteName}' finished with score: ${row.score}% (status: ${row.status}).`,
      };
    }
  } catch (err) {
    console.error("getTaskProgress error:", err);
  }
  return null;
}
