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
  type AgentRole,
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
  isUniqueViolation,
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
  uuidString,
} from "@/lib/http/validation";
import {
  SUPERVISOR_TOOL_NAME_SET,
  SUPERVISOR_TOOL_NAMES,
} from "@/lib/runner/supervisor-tools.server";
import {
  SUPERVISOR_DESCRIPTION,
  SUPERVISOR_NAME,
  SUPERVISOR_PROMPT,
} from "@/lib/constants/supervisor";

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
        // Calendar
        calendarCredentialId: BuiltinAgentToolTable.calendarCredentialId,
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
    "calendar",
  ]),
  mcpServerId: uuidString.nullable().optional(),
  mcpToolName: z.string().nullable().optional(),
  skillId: uuidString.nullable().optional(),
  builtinTool: z.string().nullable().optional(),
  dataSourceId: uuidString.nullable().optional(),
  sshServerId: uuidString.nullable().optional(),
  calendarCredentialId: uuidString.nullable().optional(),
});

const updateSchema = z
  .object({
    name: nonEmptyString.optional(),
    description: optionalTrimmedString.optional(),
    /** Monotonic: only `null → system role` is accepted; any other
     *  transition returns 409. See AGENTS.md ("agent `role` enum"). */
    role: z.enum(["supervisor", "secretary", "evaluator"]).nullable().optional(),
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
    toolApprovalMode: z.enum(["always", "auto", "never"]).optional(),
    memoryEnabled: z.boolean().optional(),
    memoryWindowSize: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
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
        role: BuiltinAgentTable.role,
        // QUIRK: read these so the supervisor-identity lock below
        // compares actual values, not "field present in body"
        // (the editor sends them all even when unchanged).
        name: BuiltinAgentTable.name,
        description: BuiltinAgentTable.description,
        prompt: BuiltinAgentTable.prompt,
      })
      .from(BuiltinAgentTable)
      .where(eq(BuiltinAgentTable.id, id))
      .limit(1);

    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Agent not found.");
    }

    const body = await parseBody(req, updateSchema);

    // CONTRACT: `role` is monotonic — only `null → system role` is
    // accepted. Any other transition → 409 (delete & recreate).
    let promotedTo: AgentRole | null = null;
    if (body.role !== undefined && body.role !== existing.role) {
      if (existing.role !== null) {
        throw new ApiError(
          "CONFLICT",
          409,
          "Agent role is immutable once set. Delete this agent and recreate to change its role.",
        );
      }
      promotedTo = body.role;
    }

    // Supervisor identity lock — reject changes to name / description
    // / prompt on an already-promoted supervisor (the promotion path
    // below predates this branch because `existing.role` is still null
    // when promoting).
    if (existing.role === "supervisor") {
      const locked: string[] = [];
      if (body.name !== undefined && body.name !== existing.name) {
        locked.push("name");
      }
      if (
        body.description !== undefined
        && (body.description ?? null) !== (existing.description ?? null)
      ) {
        locked.push("description");
      }
      if (
        body.prompt !== undefined
        && (body.prompt ?? null) !== (existing.prompt ?? null)
      ) {
        locked.push("prompt");
      }
      if (locked.length > 0) {
        throw new ApiError(
          "CONFLICT",
          409,
          `Supervisor identity is locked — cannot modify: ${locked.join(", ")}.`,
        );
      }
    }

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
    // Owner-only flips: visibility / enabled / role promotion.
    if (
      (body.visibility !== undefined
        || body.enabled !== undefined
        || promotedTo !== null)
      && !canChangeVisibility(rbac, session)
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can change visibility / enabled / role.",
      );
    }

    const updates: Partial<typeof BuiltinAgentTable.$inferInsert> = {
      updatedBy: session.user.id,
      updatedAt: new Date(),
    };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.icon !== undefined) updates.icon = body.icon;
    if (body.model !== undefined) updates.model = body.model;
    if (body.modelProvider !== undefined) updates.modelProvider = body.modelProvider;
    if (body.credentialId !== undefined) updates.credentialId = body.credentialId;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.toolChoice !== undefined) updates.toolChoice = body.toolChoice;
    if (body.toolApprovalMode !== undefined) updates.toolApprovalMode = body.toolApprovalMode;
    if (body.temperature !== undefined) updates.temperature = body.temperature != null ? String(body.temperature) : null;
    if (body.maxTokens !== undefined) updates.maxTokens = body.maxTokens;
    if (body.maxSteps !== undefined) updates.maxSteps = body.maxSteps;
    if (body.memoryEnabled !== undefined) updates.memoryEnabled = body.memoryEnabled;
    if (body.memoryWindowSize !== undefined) updates.memoryWindowSize = body.memoryWindowSize;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.visibility !== undefined) updates.visibility = body.visibility;

    // Promotion: write the new role; for supervisors, also overwrite
    // the locked identity fields with their canonical values.
    if (promotedTo !== null) {
      updates.role = promotedTo;
      if (promotedTo === "supervisor") {
        updates.name = SUPERVISOR_NAME;
        updates.description = SUPERVISOR_DESCRIPTION;
        updates.prompt = SUPERVISOR_PROMPT;
      }
    }

    const finalRole: AgentRole | null = promotedTo ?? existing.role;
    const finalIsSupervisor: boolean = finalRole === "supervisor";

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
              calendarCredentialId: t.calendarCredentialId ?? null,
              order: i,
            })),
          );
        }
      }

      // Top up any missing supervisor tool rows. Role is monotonic so
      // there's no demote branch — we never drop these.
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
      }

      return updated;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Per-role uniqueness — surface a role-aware message.
        const message: string =
          promotedTo === "secretary"
            ? "You already have a Secretary agent. Delete it first to designate a new one."
            : "You already have a Nango (Supervisor agent). Delete it first to designate a new one.";
        throw new ApiError("CONFLICT", 409, message);
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
