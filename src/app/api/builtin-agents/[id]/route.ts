import "server-only";

import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  BuiltinAgentTable,
  BuiltinAgentToolTable,
  McpServerTable,
  SkillTable,
} from "@/lib/db/schema";
import { invalidateForAgentChange } from "@/lib/cache/invalidation";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
  canViewResource,
} from "@/lib/auth/permissions";
import {
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
  uuidString,
} from "@/lib/http/validation";
import {
  SUPERVISOR_TOOL_NAME_SET,
  SUPERVISOR_TOOL_NAMES,
} from "@/lib/runner/supervisor-tools.server";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object"
    && err !== null
    && "code" in err
    && (err as { code?: unknown }).code === "23505"
  );
}

const ROUTE = "/api/builtin-agents/[id]";

// GET /api/builtin-agents/[id]
// Returns the agent detail + its bound tools/skills.

export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = params;

    const [agent] = await db
      .select()
      .from(BuiltinAgentTable)
      .where(eq(BuiltinAgentTable.id, id))
      .limit(1);

    if (
      !agent
      || !canViewResource(
        {
          source: "local",
          visibility: agent.visibility as "private" | "public",
          createdBy: agent.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError("NOT_FOUND", 404, "Agent not found.");
    }

    // Fetch bound tool rows with joined names
    const toolRows = await db
      .select({
        id: BuiltinAgentToolTable.id,
        toolType: BuiltinAgentToolTable.toolType,
        order: BuiltinAgentToolTable.order,
        // MCP
        mcpServerId: BuiltinAgentToolTable.mcpServerId,
        mcpServerName: McpServerTable.name,
        mcpToolName: BuiltinAgentToolTable.mcpToolName,
        // Skill
        skillId: BuiltinAgentToolTable.skillId,
        skillName: SkillTable.name,
        // Builtin
        builtinTool: BuiltinAgentToolTable.builtinTool,
        // DataSource
        dataSourceId: BuiltinAgentToolTable.dataSourceId,
        // SSH
        sshServerId: BuiltinAgentToolTable.sshServerId,
      })
      .from(BuiltinAgentToolTable)
      .leftJoin(McpServerTable, eq(BuiltinAgentToolTable.mcpServerId, McpServerTable.id))
      .leftJoin(SkillTable, eq(BuiltinAgentToolTable.skillId, SkillTable.id))
      .where(eq(BuiltinAgentToolTable.agentId, id))
      .orderBy(BuiltinAgentToolTable.order);

    return NextResponse.json({ ...agent, tools: toolRows });
  },
);

// PATCH /api/builtin-agents/[id]

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

const updateSchema = z
  .object({
    name: nonEmptyString.optional(),
    description: optionalTrimmedString.optional(),
    /** One-line persona surfaced to the supervisor's `list_agents`. */
    role: optionalTrimmedString.optional(),
    /** Optional emoji glyph; pass `null` to clear. */
    icon: z.string().max(8).nullable().optional(),
    model: nonEmptyString.optional(),
    modelProvider: nonEmptyString.optional(),
    credentialId: uuidString.optional(),
    prompt: optionalTrimmedString.optional(),
    temperature: z.number().min(0).max(1).nullable().optional(),
    maxTokens: z.number().int().positive().nullable().optional(),
    maxSteps: z.number().int().positive().optional(),
    toolChoice: z.enum(["auto", "required", "none"]).optional(),
    memoryEnabled: z.boolean().optional(),
    memoryWindowSize: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
    /** Promote / demote the agent as the user's Nango. */
    isSupervisor: z.boolean().optional(),
    /** When present, fully replaces all tool/skill bindings for this agent. */
    tools: z.array(boundToolSchema).optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const { id } = params;

    const [existing] = await db
      .select({
        createdBy: BuiltinAgentTable.createdBy,
        visibility: BuiltinAgentTable.visibility,
        isSupervisor: BuiltinAgentTable.isSupervisor,
      })
      .from(BuiltinAgentTable)
      .where(eq(BuiltinAgentTable.id, id))
      .limit(1);

    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Agent not found.");
    }

    const body = await parseBody(req, updateSchema);

    const rbac = {
      source: "local" as const,
      visibility: existing.visibility as "private" | "public",
      createdBy: existing.createdBy,
    };

    // Content edits — open to any editor with public access.
    const editsContent =
      body.name !== undefined
      || body.description !== undefined
      || body.role !== undefined
      || body.icon !== undefined
      || body.model !== undefined
      || body.modelProvider !== undefined
      || body.credentialId !== undefined
      || body.prompt !== undefined
      || body.toolChoice !== undefined
      || body.temperature !== undefined
      || body.maxTokens !== undefined
      || body.maxSteps !== undefined
      || body.memoryEnabled !== undefined
      || body.memoryWindowSize !== undefined
      || body.tools !== undefined;
    if (editsContent && !canEditResource(rbac, session)) {
      throw new ApiError("FORBIDDEN", 403, "You cannot edit this agent.");
    }
    // Owner-only flips: visibility / enabled / isSupervisor.
    if (
      (body.visibility !== undefined
        || body.enabled !== undefined
        || body.isSupervisor !== undefined)
      && !canChangeVisibility(rbac, session)
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can change visibility / enabled / supervisor flag.",
      );
    }

    const updates: Partial<typeof BuiltinAgentTable.$inferInsert> = {
      updatedBy: session.user.id,
      updatedAt: new Date(),
    };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.role !== undefined) updates.role = body.role;
    if (body.icon !== undefined) updates.icon = body.icon;
    if (body.model !== undefined) updates.model = body.model;
    if (body.modelProvider !== undefined) updates.modelProvider = body.modelProvider;
    if (body.credentialId !== undefined) updates.credentialId = body.credentialId;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.toolChoice !== undefined) updates.toolChoice = body.toolChoice;
    if (body.temperature !== undefined) updates.temperature = body.temperature != null ? String(body.temperature) : null;
    if (body.maxTokens !== undefined) updates.maxTokens = body.maxTokens;
    if (body.maxSteps !== undefined) updates.maxSteps = body.maxSteps;
    if (body.memoryEnabled !== undefined) updates.memoryEnabled = body.memoryEnabled;
    if (body.memoryWindowSize !== undefined) updates.memoryWindowSize = body.memoryWindowSize;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.visibility !== undefined) updates.visibility = body.visibility;
    if (body.isSupervisor !== undefined) updates.isSupervisor = body.isSupervisor;

    const finalIsSupervisor: boolean =
      body.isSupervisor ?? existing.isSupervisor;

    // Run agent update + optional tool replacement in a transaction
    let row;
    try {
      row = await db.transaction(async (tx) => {
      // PATCH always sets updatedBy/updatedAt so this UPDATE always fires;
      // the .returning() result is the canonical post-update row.
      const [updated] = await tx
        .update(BuiltinAgentTable)
        .set(updates)
        .where(eq(BuiltinAgentTable.id, id))
        .returning();

      // Replace tools if provided. Supervisor tools are managed exclusively by the role flip logic below.
      if (body.tools !== undefined) {
        await tx
          .delete(BuiltinAgentToolTable)
          .where(eq(BuiltinAgentToolTable.agentId, id));
        const userTools = body.tools.filter(
          (t) =>
            t.toolType !== "builtin_tool"
            || (t.builtinTool !== null
              && t.builtinTool !== undefined
              && !SUPERVISOR_TOOL_NAME_SET.has(t.builtinTool)),
        );
        if (userTools.length > 0) {
          await tx.insert(BuiltinAgentToolTable).values(
            userTools.map((t, i) => ({
              agentId: id,
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
      }

      // Sync supervisor tool junction rows with the final flag.
      if (finalIsSupervisor) {
        const existingRows: Array<{ name: string | null }> = await tx
          .select({ name: BuiltinAgentToolTable.builtinTool })
          .from(BuiltinAgentToolTable)
          .where(
            and(
              eq(BuiltinAgentToolTable.agentId, id),
              eq(BuiltinAgentToolTable.toolType, "builtin_tool"),
            ),
          );
        const have = new Set(
          existingRows.map((r) => r.name).filter((n): n is string => n !== null),
        );
        const toAdd = SUPERVISOR_TOOL_NAMES.filter((n) => !have.has(n));
        if (toAdd.length > 0) {
          await tx.insert(BuiltinAgentToolTable).values(
            toAdd.map((name, i) => ({
              agentId: id,
              toolType: "builtin_tool",
              builtinTool: name,
              order: 1000 + i, // append after user-defined tools
            })),
          );
        }
      } else {
        // demote: drop any supervisor tool rows
        for (const name of SUPERVISOR_TOOL_NAMES) {
          await tx
            .delete(BuiltinAgentToolTable)
            .where(
              and(
                eq(BuiltinAgentToolTable.agentId, id),
                eq(BuiltinAgentToolTable.toolType, "builtin_tool"),
                eq(BuiltinAgentToolTable.builtinTool, name),
              ),
            );
        }
      }

      return updated;
      });
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

    // Drop only this agent's cached spec; other agents stay warm.
    invalidateForAgentChange(id);

    return NextResponse.json(row);
  },
);

// DELETE /api/builtin-agents/[id]

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = params;

    const [existing] = await db
      .select({
        createdBy: BuiltinAgentTable.createdBy,
        visibility: BuiltinAgentTable.visibility,
      })
      .from(BuiltinAgentTable)
      .where(eq(BuiltinAgentTable.id, id))
      .limit(1);

    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Agent not found.");
    }
    if (
      !canDeleteResource(
        {
          source: "local",
          visibility: existing.visibility as "private" | "public",
          createdBy: existing.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this agent.",
      );
    }

    await db.delete(BuiltinAgentTable).where(eq(BuiltinAgentTable.id, id));
    invalidateForAgentChange(id);

    return new NextResponse(null, { status: 204 });
  },
);
