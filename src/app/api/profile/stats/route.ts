import "server-only";

import { NextResponse } from "next/server";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  BuiltinAgentTable,
  BuiltinAgentToolTable,
  DataSourceTable,
  EntityRunTable,
  McpServerTable,
  SkillTable,
  SshServerTable,
} from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";

const ROUTE = "/api/profile/stats";

interface TopItem {
  id: string;
  name: string;
  count: number;
}

interface ResourceStats {
  total: number;
  top: TopItem[];
}

export interface ProfileStatsResponse {
  agents: ResourceStats;
  skills: ResourceStats;
  mcp: ResourceStats;
  ssh: ResourceStats;
  database: ResourceStats;
}

export const GET = withSession(ROUTE, async ({ session }) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  // ---- Step 1: totals (all 5 in parallel, simple COUNT queries) ----
  const [
    [agentTotal],
    [skillTotal],
    [mcpTotal],
    [sshTotal],
    [dsTotal],
  ] = await Promise.all([
    db.select({ total: count() }).from(BuiltinAgentTable)
      .where(and(
        visibilitySql(session, BuiltinAgentTable.visibility, BuiltinAgentTable.createdBy),
        sql`${BuiltinAgentTable.role} IS NULL`,
      )),
    db.select({ total: count() }).from(SkillTable)
      .where(visibilitySql(session, SkillTable.visibility, SkillTable.createdBy)),
    db.select({ total: count() }).from(McpServerTable)
      .where(visibilitySql(session, McpServerTable.visibility, McpServerTable.createdBy)),
    db.select({ total: count() }).from(SshServerTable)
      .where(visibilitySql(session, SshServerTable.visibility, SshServerTable.createdBy)),
    db.select({ total: count() }).from(DataSourceTable)
      .where(visibilitySql(session, DataSourceTable.visibility, DataSourceTable.createdBy)),
  ]);

  // ---- Step 2: agent run counts (single table, no JOIN) ----
  // entity_id is text; agent id is uuid — compare as text to avoid cast.
  const agentRunCounts = await db
    .select({
      entityId: EntityRunTable.entityId,
      cnt: count(),
    })
    .from(EntityRunTable)
    .where(and(
      eq(EntityRunTable.entitySource, "builtin"),
      eq(EntityRunTable.entityKind, "agent"),
      gte(EntityRunTable.createdAt, cutoff),
    ))
    .groupBy(EntityRunTable.entityId);

  // Build a lookup map: agentId (text) → run count
  const agentRunMap = new Map<string, number>();
  for (const r of agentRunCounts) {
    agentRunMap.set(r.entityId, Number(r.cnt));
  }

  // ---- Step 3: agent top 5 ----
  // Fetch visible agent rows, then rank in JS (avoids entity_run JOIN).
  const agentVisibility = visibilitySql(
    session,
    BuiltinAgentTable.visibility,
    BuiltinAgentTable.createdBy,
  );
  const visibleAgents = await db
    .select({ id: BuiltinAgentTable.id, name: BuiltinAgentTable.name })
    .from(BuiltinAgentTable)
    .where(and(agentVisibility, sql`${BuiltinAgentTable.role} IS NULL`));

  const agentTop: TopItem[] = visibleAgents
    .map((a) => ({ id: a.id, name: a.name, count: agentRunMap.get(a.id) ?? 0 }))
    .filter((a) => a.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ---- Step 4: tool-resource top 5 ----
  // For skills / MCP / SSH / datasource, count how many recent runs
  // touched agents that bind each resource. Two-step: get bindings,
  // then sum agentRunMap counts per resource — all in-memory, no
  // further DB round-trips.
  const toolBindings = await db
    .select({
      toolType: BuiltinAgentToolTable.toolType,
      agentId: BuiltinAgentToolTable.agentId,
      skillId: BuiltinAgentToolTable.skillId,
      mcpServerId: BuiltinAgentToolTable.mcpServerId,
      sshServerId: BuiltinAgentToolTable.sshServerId,
      dataSourceId: BuiltinAgentToolTable.dataSourceId,
    })
    .from(BuiltinAgentToolTable)
    .where(
      inArray(BuiltinAgentToolTable.toolType, [
        "skill", "mcp_server", "mcp_tool", "ssh_server", "datasource",
      ]),
    );

  // Accumulate run counts per resource id, grouped by resource type.
  type ResourceType = "skill" | "mcp" | "ssh" | "datasource";
  const usageMap: Record<ResourceType, Map<string, number>> = {
    skill: new Map(),
    mcp: new Map(),
    ssh: new Map(),
    datasource: new Map(),
  };

  for (const b of toolBindings) {
    const runs = agentRunMap.get(b.agentId) ?? 0;
    if (runs === 0) continue;

    let type: ResourceType | null = null;
    let resId: string | null = null;

    if (b.toolType === "skill" && b.skillId) {
      type = "skill"; resId = b.skillId;
    } else if ((b.toolType === "mcp_server" || b.toolType === "mcp_tool") && b.mcpServerId) {
      type = "mcp"; resId = b.mcpServerId;
    } else if (b.toolType === "ssh_server" && b.sshServerId) {
      type = "ssh"; resId = b.sshServerId;
    } else if (b.toolType === "datasource" && b.dataSourceId) {
      type = "datasource"; resId = b.dataSourceId;
    }

    if (type && resId) {
      usageMap[type].set(resId, (usageMap[type].get(resId) ?? 0) + runs);
    }
  }

  // Fetch resource names for items that actually have usage.
  async function resolveTop(
    type: ResourceType,
    table: typeof SkillTable | typeof McpServerTable | typeof SshServerTable | typeof DataSourceTable,
  ): Promise<TopItem[]> {
    const usage = usageMap[type];
    if (usage.size === 0) return [];

    // Get top 5 ids by count
    const sorted = [...usage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const topIds = sorted.map(([id]) => id);

    // Fetch names
    const rows = await db
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(and(
        inArray(table.id, topIds),
        visibilitySql(session, table.visibility, table.createdBy),
      ));

    const nameMap = new Map(rows.map((r) => [r.id, r.name]));

    return sorted
      .filter(([id]) => nameMap.has(id))
      .map(([id, cnt]) => ({ id, name: nameMap.get(id)!, count: cnt }));
  }

  const [skillTop, mcpTop, sshTop, dsTop] = await Promise.all([
    resolveTop("skill", SkillTable),
    resolveTop("mcp", McpServerTable),
    resolveTop("ssh", SshServerTable),
    resolveTop("datasource", DataSourceTable),
  ]);

  const body: ProfileStatsResponse = {
    agents: { total: agentTotal.total, top: agentTop },
    skills: { total: skillTotal.total, top: skillTop },
    mcp: { total: mcpTotal.total, top: mcpTop },
    ssh: { total: sshTotal.total, top: sshTop },
    database: { total: dsTotal.total, top: dsTop },
  };

  return NextResponse.json(body);
});
