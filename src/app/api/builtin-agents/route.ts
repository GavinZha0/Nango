import "server-only";

import { NextResponse } from "next/server";
import { desc, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { BuiltinAgentTable, BuiltinAgentToolTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";
import {
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
  uuidString,
} from "@/lib/http/validation";
import { SUPERVISOR_PERSONA_SEED } from "@/lib/constants/supervisor";
import { SUPERVISOR_TOOL_NAMES } from "@/lib/runner/supervisor-tools.server";

const ROUTE = "/api/builtin-agents";

// GET /api/builtin-agents
// Returns the caller's own agents + all public agents, with tool/skill counts.

export const GET = withSession(ROUTE, async ({ session }) => {
  const rows = await db
    .select({
      id: BuiltinAgentTable.id,
      isSupervisor: BuiltinAgentTable.isSupervisor,
      role: BuiltinAgentTable.role,
      icon: BuiltinAgentTable.icon,
      name: BuiltinAgentTable.name,
      description: BuiltinAgentTable.description,
      model: BuiltinAgentTable.model,
      modelProvider: BuiltinAgentTable.modelProvider,
      prompt: BuiltinAgentTable.prompt,
      temperature: BuiltinAgentTable.temperature,
      maxTokens: BuiltinAgentTable.maxTokens,
      maxSteps: BuiltinAgentTable.maxSteps,
      toolChoice: BuiltinAgentTable.toolChoice,
      memoryEnabled: BuiltinAgentTable.memoryEnabled,
      memoryWindowSize: BuiltinAgentTable.memoryWindowSize,
      enabled: BuiltinAgentTable.enabled,
      visibility: BuiltinAgentTable.visibility,
      createdBy: BuiltinAgentTable.createdBy,
      createdAt: BuiltinAgentTable.createdAt,
      updatedAt: BuiltinAgentTable.updatedAt,
      credentialId: BuiltinAgentTable.credentialId,
      // Total number of tool rows attached to this agent
      toolCount: sql<number>`(
        select count(*)::int from builtin_agent_tool
        where builtin_agent_tool.agent_id = "builtin_agent"."id"
      )`,
      // Number of skill-type tool rows
      skillCount: sql<number>`(
        select count(*)::int from builtin_agent_tool
        where builtin_agent_tool.agent_id = "builtin_agent"."id"
          and builtin_agent_tool.tool_type = 'skill'
      )`,
    })
    .from(BuiltinAgentTable)
    .where(
      visibilitySql(
        session,
        BuiltinAgentTable.visibility,
        BuiltinAgentTable.createdBy,
      ),
    )
    .orderBy(desc(BuiltinAgentTable.createdAt));

  return NextResponse.json(rows);
});

// POST /api/builtin-agents

const createSchema = z.object({
  name: nonEmptyString,
  description: optionalTrimmedString.optional(),
  /** One-line persona, surfaced to the supervisor's `list_agents`. */
  role: optionalTrimmedString.optional(),
  /** Optional emoji glyph for visual identification.
   *  Stored as a raw Unicode character (1-4 codepoints). */
  icon: z.string().max(8).nullable().optional(),
  model: nonEmptyString,
  modelProvider: nonEmptyString,
  credentialId: uuidString,
  prompt: optionalTrimmedString.optional(),
  temperature: z.number().min(0).max(1).nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  maxSteps: z.number().int().positive().optional(),
  toolChoice: z.enum(["auto", "required", "none"]).optional(),
  memoryEnabled: z.boolean().optional(),
  memoryWindowSize: z.number().int().positive().nullable().optional(),
  visibility: z.enum(["private", "public"]).optional(),
  /** Promote the new agent to be the user's Nango. */
  isSupervisor: z.boolean().optional(),
});

/**
 * Wrap a Drizzle write that may collide with the per-user supervisor
 * unique index. Postgres surfaces the violation as code "23505"; we
 * translate it into a 409 CONFLICT so the UI can render a friendly
 * message instead of a generic 500.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object"
    && err !== null
    && "code" in err
    && (err as { code?: unknown }).code === "23505"
  );
}

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);
  const isSupervisor = body.isSupervisor ?? false;

  // Seed the default Nango prompt only when promoting at creation time.
  const seededPrompt =
    isSupervisor && !body.prompt ? SUPERVISOR_PERSONA_SEED : body.prompt ?? null;

  try {
    const row = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(BuiltinAgentTable)
        .values({
          isSupervisor,
          name: body.name,
          description: body.description ?? null,
          role: body.role ?? null,
          icon: body.icon ?? null,
          model: body.model,
          modelProvider: body.modelProvider,
          credentialId: body.credentialId,
          prompt: seededPrompt,
          temperature: body.temperature != null ? String(body.temperature) : null,
          maxTokens: body.maxTokens ?? null,
          maxSteps: body.maxSteps ?? 5,
          toolChoice: body.toolChoice ?? "auto",
          memoryEnabled: body.memoryEnabled ?? false,
          memoryWindowSize: body.memoryWindowSize ?? null,
          enabled: true,
          visibility: body.visibility ?? "private",
          createdBy: session.user.id,
        })
        .returning();

      if (isSupervisor) {
        await tx.insert(BuiltinAgentToolTable).values(
          SUPERVISOR_TOOL_NAMES.map((name, i) => ({
            agentId: agent.id,
            toolType: "builtin_tool",
            builtinTool: name,
            order: i,
          })),
        );
      }
      return agent;
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        "CONFLICT",
        409,
        "You already have a Nango (supervisor agent). Demote it first to designate a new one.",
      );
    }
    throw err;
  }
});
