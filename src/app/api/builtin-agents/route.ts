import "server-only";

import { NextResponse } from "next/server";
import { desc, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { BuiltinAgentTable, BuiltinAgentToolTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";
import {
  isUniqueViolation,
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
  uuidString,
} from "@/lib/http/validation";
import {
  SUPERVISOR_DESCRIPTION,
  SUPERVISOR_NAME,
  SUPERVISOR_PROMPT,
} from "@/lib/constants/supervisor";
import {
  SUPERVISOR_TOOL_NAME_SET,
  SUPERVISOR_TOOL_NAMES,
} from "@/lib/runner/supervisor-tools.server";
import type { AgentRole } from "@/lib/db/schema";

const ROUTE = "/api/builtin-agents";

// GET /api/builtin-agents
// Returns the caller's own agents + all public agents, with tool/skill counts.

export const GET = withSession(ROUTE, async ({ session }) => {
  const rows = await db
    .select({
      id: BuiltinAgentTable.id,
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

// Keep in sync with the identical schema in `[id]/route.ts`.
const boundToolSchema = z.object({
  toolType: z.enum([
    "mcp_server",
    "mcp_tool",
    "skill",
    "builtin_tool",
    "datasource",
    "ssh_server",
  ]),
  mcpServerId: uuidString.nullable().optional(),
  mcpToolName: z.string().nullable().optional(),
  skillId: uuidString.nullable().optional(),
  builtinTool: z.string().nullable().optional(),
  dataSourceId: uuidString.nullable().optional(),
  sshServerId: uuidString.nullable().optional(),
});

const createSchema = z.object({
  name: nonEmptyString,
  description: optionalTrimmedString.optional(),
  /** System-agent role; `null` / omitted = regular agent. For
   *  `supervisor` the server overwrites name / description / prompt
   *  with canonical values regardless of what the client sent. */
  role: z.enum(["supervisor", "secretary", "evaluator"]).nullable().optional(),
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
  /** Initial tool bindings. Supervisor-injected names in
   *  `SUPERVISOR_TOOL_NAMES` are dropped from client input
   *  (server-managed). */
  tools: z.array(boundToolSchema).optional(),
});



export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);
  const role: AgentRole | null = body.role ?? null;
  const isSupervisor: boolean = role === "supervisor";

  // Supervisor identity is server-managed; see lib/constants/supervisor.ts.
  const finalName: string = isSupervisor ? SUPERVISOR_NAME : body.name;
  const finalDescription: string | null = isSupervisor
    ? SUPERVISOR_DESCRIPTION
    : body.description ?? null;
  const finalPrompt: string | null = isSupervisor
    ? SUPERVISOR_PROMPT
    : body.prompt ?? null;

  try {
    const row = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(BuiltinAgentTable)
        .values({
          role,
          name: finalName,
          description: finalDescription,
          icon: body.icon ?? null,
          model: body.model,
          modelProvider: body.modelProvider,
          credentialId: body.credentialId,
          prompt: finalPrompt,
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

      // Insert user-supplied bindings, dropping supervisor-injected
      // tool names (server appends those itself below).
      const userTools = (body.tools ?? []).filter(
        (t) =>
          t.toolType !== "builtin_tool"
          || (t.builtinTool !== null
            && t.builtinTool !== undefined
            && !SUPERVISOR_TOOL_NAME_SET.has(t.builtinTool)),
      );
      if (userTools.length > 0) {
        await tx.insert(BuiltinAgentToolTable).values(
          userTools.map((t, i) => ({
            agentId: agent.id,
            toolType: t.toolType,
            mcpServerId: t.mcpServerId ?? null,
            mcpToolName: t.mcpToolName ?? null,
            skillId: t.skillId ?? null,
            builtinTool: t.builtinTool ?? null,
            dataSourceId: t.dataSourceId ?? null,
            sshServerId: t.sshServerId ?? null,
            order: i,
          })),
        );
      }

      // Supervisor self-injected tools — order 1000+ matches PATCH path.
      if (isSupervisor) {
        await tx.insert(BuiltinAgentToolTable).values(
          SUPERVISOR_TOOL_NAMES.map((name, i) => ({
            agentId: agent.id,
            toolType: "builtin_tool",
            builtinTool: name,
            order: 1000 + i,
          })),
        );
      }
      return agent;
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Per-role uniqueness — surface a role-aware message.
      const message: string =
        role === "secretary"
          ? "You already have a Secretary agent. Delete it first to designate a new one."
          : "You already have a Nango (Supervisor agent). Delete it first to designate a new one.";
      throw new ApiError("CONFLICT", 409, message);
    }
    throw err;
  }
});
