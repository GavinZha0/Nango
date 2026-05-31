/**
 * Supervisor server-side tools: `delegate_to_agent`, `delegate_async`,
 * `create_schedule`, `list_schedules`, `update_schedule`,
 * `delete_schedule`.
 *
 * See docs/orchestrator.md.
 */

import "server-only";

import { defineTool } from "@/lib/copilot/index.server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { db } from "@/lib/db";
import { BuiltinAgentTable, ScheduleTable } from "@/lib/db/schema";
import { listVisibleAgentIds } from "@/lib/access/agent-visibility";
import { EntityCatalog } from "@/lib/backends/entity-catalog";
import { runner } from "@/lib/runner";
import { getUserTimezone } from "@/lib/time/user-timezone";
import {
  nextFireAt,
  registerSchedule,
  unregisterSchedule,
  validateTriggerSpec,
} from "@/lib/runner/scheduler";
import { applyScheduleUpdate } from "@/lib/runner/schedule-mutate";
import type { EntityKind } from "@/lib/backends/types";
import { childLogger } from "@/lib/observability/logger";
import { getConfigNumber } from "@/lib/config";
import {
  computeDisplayName,
  computeSourceLabel,
} from "@/lib/orchestration/display-name";

const log = childLogger({ component: "supervisor-tools" });

/** Fallback used when the config row is missing from the DB. */
const DEFAULT_EXCERPT_CHARS = 300;

/** Mutable holder set by the runner after the supervisor's
 *  entity_run row is created. Read lazily at tool-execute time so
 *  sub-runs link back via `parent_run_id` AND stay grouped under the
 *  same `thread_id` (admin `/admin/thread/[id]` filters by threadId). */
export interface ParentRunIdHolder {
  current: string | undefined;
  /** Inherited by sub-runs. May be undefined for programmatic /
   *  scheduled parents that had no threadId. */
  threadId: string | undefined;
}

export interface SupervisorRuntimeContext {
  userId: string;
  /** Supervisor's own id — for self-filter and log correlation. */
  supervisorAgentId: string;
  parentRunIdHolder: ParentRunIdHolder;
}

/** Agent card the supervisor sees in its prompt. Deliberately narrow
 *  — no model choice / tool inventory / internal ids leak through. */
interface AgentCard {
  /** Globally unique within the user's catalog; the routing key. */
  displayName: string;
  sourceLabel: string;
  kind: EntityKind;
  name?: string;
  description?: string;
  role?: string;
  promptExcerpt?: string;
}

/** Public card + server-only routing keys. */
interface CatalogEntry {
  card: AgentCard;
  source: "backend" | "builtin";
  /** Real entity id passed to runner.start. */
  entityId: string;
  /** Backend entities only. */
  credentialId?: string;
}

function excerpt(prompt: string | null | undefined): string | undefined {
  if (!prompt) return undefined;
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return undefined;
  const maxChars = getConfigNumber("supervisor.catalog_excerpt_chars", DEFAULT_EXCERPT_CHARS);
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars)}…`
    : trimmed;
}

/** Enumerate every entity the user can delegate to. The supervisor
 *  itself is excluded — the LLM must never see itself listed. */
async function buildCatalog(
  ctx: SupervisorRuntimeContext,
): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];

  const { db: dbInstance } = await import("@/lib/db");
  const { CredentialTable } = await import("@/lib/db/schema");
  const credRows: Array<{ id: string; name: string }> = await dbInstance
    .select({ id: CredentialTable.id, name: CredentialTable.name })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.serviceType, "agent"),
        eq(CredentialTable.enabled, true),
      ),
    );
  for (const cred of credRows) {
    let table: Awaited<ReturnType<typeof EntityCatalog.list>>;
    try {
      table = await EntityCatalog.list(cred.id);
    } catch (err) {
      log.warn(
        { event: "catalog_fetch_failed", credentialId: cred.id, err: err instanceof Error ? err.message : String(err) },
        "failed to fetch backend entity catalog; skipping credential",
      );
      continue;
    }
    if (!table) continue;
    for (const e of table) {
      const sourceLabel = computeSourceLabel({
        source: "backend",
        credentialName: cred.name,
      });
      const displayName = computeDisplayName({
        source: "backend",
        credentialName: cred.name,
        name: e.name ?? e.id,
      });
      entries.push({
        card: {
          displayName,
          sourceLabel,
          kind: e.kind,
          name: e.name,
          description: e.description,
          role: e.role,
          promptExcerpt: excerpt(e.prompt),
        },
        source: "backend",
        entityId: e.id,
        credentialId: cred.id,
      });
    }
  }

  const visibleIds = await listVisibleAgentIds(ctx.userId);
  for (const id of visibleIds) {
    if (id === ctx.supervisorAgentId) continue;
    const rows: Array<{
      name: string;
      description: string | null;
      role: string | null;
      prompt: string | null;
      isSupervisor: boolean;
      createdBy: string | null;
      visibility: string;
    }> = await db
      .select({
        name: BuiltinAgentTable.name,
        description: BuiltinAgentTable.description,
        role: BuiltinAgentTable.role,
        prompt: BuiltinAgentTable.prompt,
        isSupervisor: BuiltinAgentTable.isSupervisor,
        createdBy: BuiltinAgentTable.createdBy,
        visibility: BuiltinAgentTable.visibility,
      })
      .from(BuiltinAgentTable)
      .where(eq(BuiltinAgentTable.id, id))
      .limit(1);
    if (rows.length === 0) continue;
    // Defensive — per-user uniqueness already prevents a second supervisor.
    if (rows[0].isSupervisor) continue;

    const isPublicByOthers =
      rows[0].visibility === "public" && rows[0].createdBy !== ctx.userId;
    const sourceLabel = computeSourceLabel({
      source: "builtin",
      isPublicByOthers,
    });
    const displayName = computeDisplayName({
      source: "builtin",
      isPublicByOthers,
      name: rows[0].name,
    });
    entries.push({
      card: {
        displayName,
        sourceLabel,
        kind: "agent",
        name: rows[0].name,
        description: rows[0].description ?? undefined,
        role: rows[0].role ?? undefined,
        promptExcerpt: excerpt(rows[0].prompt),
      },
      source: "builtin",
      entityId: id,
    });
  }

  return entries;
}

/** Render catalog as a markdown block for the supervisor's system
 *  prompt. Only routing-bearing fields leak; routing keys stay server-only. */
function formatCatalogBlock(entries: CatalogEntry[]): string {
  if (entries.length === 0) {
    return [
      "## Available agents (specialists)",
      "",
      "_No agents are currently configured. Answer the user directly_",
      "_or, if delegation would be needed, tell them which capability_",
      "_is missing._",
    ].join("\n");
  }

  const lines: string[] = [
    "## Available agents (specialists)",
    "",
    "This catalog lists agents, teams, and workflows under one banner.",
    "Pass any heading text below as the `agent` argument of",
    "`delegate_to_agent` / `delegate_async` / `switch_agent_with_context`;",
    "each entry's `kind` tells you which protocol it speaks: `agent`",
    "(single conversational unit), `team` (multi-agent group), or",
    "`workflow` (directed graph / one-shot run). Call",
    "`get_agent_details` for an agent's role and prompt excerpt when",
    "picking between similar options. The catalog is exhaustive — if",
    "no listed agent fits, answer directly and tell the user what",
    "capability is missing.",
    "",
  ];
  // Slim listing: name + kind + a one-line description. Role and the
  // 300-char prompt excerpt move to `get_agent_details` (progressive
  // disclosure) so the catalog stays cheap when many agents are
  // configured. Lookup tool reads the same in-memory `catalogByName`
  // map — zero extra DB cost.
  for (const { card } of entries) {
    lines.push(`### ${card.displayName}`);
    lines.push(`- kind: ${card.kind}`);
    if (card.description) lines.push(`- description: ${card.description}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export interface SupervisorRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ReturnType<typeof defineTool<any>>[];
  /** Markdown catalog block appended to the supervisor's system
   *  prompt. Empty-catalog content is included so the supervisor
   *  still knows "nothing to delegate to". */
  catalogPromptBlock: string;
}

/** Build the supervisor tool set + catalog block. CONTRACT: catalog
 *  precomputed so each delegate resolves names without a DB roundtrip. */
export async function buildSupervisorRuntime(
  ctx: SupervisorRuntimeContext,
): Promise<SupervisorRuntime> {
  const entries = await buildCatalog(ctx);
  const catalogByName = new Map(entries.map((e) => [e.card.displayName, e]));
  const catalogPromptBlock = formatCatalogBlock(entries);
  // Snapshot the user's profile timezone once — captured in
  // `create_schedule`'s closure so it can default to the user's main
  // tz when the LLM omits the param. One DB read per supervisor build
  // rather than one per tool invocation; matches the catalog cache
  // pattern. Null = no profile tz set → fall back to UTC inside the
  // tool (preserves prior behaviour for fresh users).
  const profileTimezone = await getUserTimezone(ctx.userId);

  // LLM passes the displayName; server resolves to (entityId,
  // credentialId) via the captured catalog map.
  const delegate = defineTool({
    name: "delegate_to_agent",
    description:
      "Run another agent with a specific task and get its final reply back as a single string. Pass `agent` exactly as listed under 'Available agents' in this prompt. The dispatched agent runs to completion before this returns; its full event timeline is persisted as a child run.",
    parameters: z.object({
      agent: z
        .string()
        .describe(
          "Agent display name as listed under 'Available agents' (e.g. 'Built-in / FirstAgent').",
        ),
      task: z
        .string()
        .describe(
          "Direct instruction for the agent (e.g. \"Analyze ...\", " +
          "\"Generate ...\", \"Plan ...\"). See the \"Routing tools\" " +
          "section of the system prompt for the required phrasing.",
        ),
    }),
    execute: async ({ agent, task }) => {
      const entry = catalogByName.get(agent.trim());
      if (!entry) {
        const available = [...catalogByName.keys()].join(" | ");
        return {
          ok: false as const,
          error: `Agent '${agent}' not found. Available: ${available || "(none)"}`,
        };
      }
      try {
        const result = await runner.start({
          entityId: entry.entityId,
          credentialId: entry.credentialId,
          // Built-in always "agent"; backend takes kind from catalog.
          entityKind: entry.source === "backend" ? entry.card.kind : "agent",
          task,
          mode: "sync",
          parentRunId: ctx.parentRunIdHolder.current,
          // Inherit threadId so the sub-run lands in the same admin thread.
          threadId: ctx.parentRunIdHolder.threadId,
          initiator: "orchestrator",
          ownerId: ctx.userId,
          createdBy: ctx.userId,
        });
        return {
          ok: true as const,
          runId: result.runId,
          status: result.status,
          summary: result.summary,
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          {
            event: "delegate_failed",
            err: message,
            agent,
            entityId: entry.entityId,
            credentialId: entry.credentialId,
            userId: ctx.userId,
          },
          "delegate_to_agent failed",
        );
        return { ok: false as const, error: message };
      }
    },
  });

  // Async sibling of delegate — returns runId immediately and the
  // supervisor wraps up its turn. User notified via EventBus on terminal.
  const delegateAsync = defineTool({
    name: "delegate_async",
    description:
      "Dispatch an agent task in the background and return immediately. Pass `agent` exactly as listed under 'Available agents'. The tool returns a `runId` right away; the user will be notified when the agent finishes. Use this when the user has enabled async mode or when a task is expected to take a while.",
    parameters: z.object({
      agent: z
        .string()
        .describe(
          "Agent display name as listed under 'Available agents' (e.g. 'Built-in / FirstAgent').",
        ),
      task: z
        .string()
        .describe(
          "Direct instruction for the agent (e.g. \"Analyze ...\", " +
          "\"Generate ...\", \"Plan ...\"). See the \"Routing tools\" " +
          "section of the system prompt for the required phrasing.",
        ),
    }),
    execute: async ({ agent, task }) => {
      const entry = catalogByName.get(agent.trim());
      if (!entry) {
        const available = [...catalogByName.keys()].join(" | ");
        return {
          ok: false as const,
          error: `Agent '${agent}' not found. Available: ${available || "(none)"}`,
        };
      }
      try {
        const result = await runner.start({
          entityId: entry.entityId,
          credentialId: entry.credentialId,
          entityKind: entry.source === "backend" ? entry.card.kind : "agent",
          task,
          mode: "async",
          parentRunId: ctx.parentRunIdHolder.current,
          threadId: ctx.parentRunIdHolder.threadId,
          initiator: "orchestrator",
          ownerId: ctx.userId,
          createdBy: ctx.userId,
          sourceLabel: entry.card.displayName,
        });
        return {
          ok: true as const,
          runId: result.runId,
          status: result.status,
          message: `Started '${agent}' in the background; you'll be notified when it finishes.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          {
            event: "delegate_async_failed",
            err: message,
            agent,
            entityId: entry.entityId,
            credentialId: entry.credentialId,
            userId: ctx.userId,
          },
          "delegate_async failed",
        );
        return { ok: false as const, error: message };
      }
    },
  });

  // Progressive-disclosure lookup over the same in-memory `catalogByName`
  // map the routing tools use — zero extra DB roundtrips. The catalog
  // block deliberately omits role / promptExcerpt to keep the prompt
  // small; this tool surfaces them on demand when the supervisor needs
  // to disambiguate between similar-sounding agents.
  const getAgentDetails = defineTool({
    name: "get_agent_details",
    description:
      "Look up an agent's role and a short excerpt of its own system " +
      "prompt by display name. Use this when picking between " +
      "similar-sounding agents in the catalog — the catalog only " +
      "shows name + kind + description; this tool reveals the rest.",
    parameters: z.object({
      agent: z
        .string()
        .describe(
          "Agent display name exactly as listed under 'Available agents' " +
          "(e.g. 'Built-in / FirstAgent').",
        ),
    }),
    execute: async ({ agent }) => {
      const entry = catalogByName.get(agent.trim());
      if (!entry) {
        const available = [...catalogByName.keys()].join(" | ");
        return {
          ok: false as const,
          error: `Agent '${agent}' not found. Available: ${available || "(none)"}`,
        };
      }
      return {
        ok: true as const,
        displayName: entry.card.displayName,
        kind: entry.card.kind,
        description: entry.card.description ?? null,
        role: entry.card.role ?? null,
        promptExcerpt: entry.card.promptExcerpt ?? null,
      };
    },
  });

  // Persist a one-shot / recurring rule and arm its in-process timer.
  // Spec: `(startAt, [intervalValue, intervalUnit], [endAt])` — no
  // cron. One-shots auto-disable after fire; recurring past endAt.
  const createSchedule = defineTool({
    name: "create_schedule",
    description:
      "Create a one-shot or recurring schedule that fires `task` against the named agent. Pass `agent` exactly as listed under 'Available agents'. `startAt` (ISO datetime) is required and is the first fire. Add `intervalValue` + `intervalUnit` (one of 'minute' | 'hour' | 'day' | 'week' | 'month') for a recurring schedule. Add `endAt` (ISO datetime) to cap a recurring schedule. Optional `timezone` is an IANA name (e.g. 'America/New_York'); when omitted, defaults to the user's profile timezone. Before computing a relative time like 'tomorrow 9am' or 'in 30 minutes', call `get_current_datetime` first to anchor on the actual wall clock. Each fire produces a notification when it finishes.",
    parameters: z.object({
      agent: z
        .string()
        .describe(
          "Agent display name as listed under 'Available agents'.",
        ),
      task: z
        .string()
        .describe(
          "Direct instruction for the agent (e.g. \"Analyze ...\", " +
          "\"Generate ...\", \"Plan ...\"). See the \"Routing tools\" " +
          "section of the system prompt for the required phrasing.",
        ),
      startAt: z
        .string()
        .describe(
          "ISO-8601 datetime of the first scheduled fire (e.g. '2026-05-01T09:00:00-04:00').",
        ),
      intervalValue: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Positive integer multiplier for the recurrence. Omit for a one-shot schedule.",
        ),
      intervalUnit: z
        .enum(["minute", "hour", "day", "week", "month"])
        .optional()
        .describe(
          "Calendar unit paired with `intervalValue`. Omit for a one-shot.",
        ),
      endAt: z
        .string()
        .optional()
        .describe(
          "Optional ISO-8601 datetime cap for a recurring schedule. Past this point the schedule auto-disables.",
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone, e.g. 'America/New_York'. Defaults to the " +
          "user's profile timezone, then UTC.",
        ),
      name: z
        .string()
        .optional()
        .describe("Optional human-readable label shown in the panel."),
    }),
    execute: async ({
      agent,
      task,
      startAt,
      intervalValue,
      intervalUnit,
      endAt,
      timezone,
      name,
    }) => {
      const entry = catalogByName.get(agent.trim());
      if (!entry) {
        const available = [...catalogByName.keys()].join(" | ");
        return {
          ok: false as const,
          error: `Agent '${agent}' not found. Available: ${available || "(none)"}`,
        };
      }
      const tz = timezone?.trim() || profileTimezone || "UTC";
      const startDate = new Date(startAt);
      const endDate = endAt ? new Date(endAt) : null;
      const ivValue = intervalValue ?? null;
      const ivUnit = intervalUnit ?? null;
      const validation = validateTriggerSpec({
        startAt: startDate,
        endAt: endDate,
        intervalValue: ivValue,
        intervalUnit: ivUnit,
        timezone: tz,
      });
      if (!validation.ok) {
        return { ok: false as const, error: validation.error };
      }
      try {
        const [row] = await db
          .insert(ScheduleTable)
          .values({
            ownerId: ctx.userId,
            createdBy: ctx.userId,
            entityId: entry.entityId,
            entityKind: entry.source === "backend" ? entry.card.kind : "agent",
            credentialId: entry.credentialId ?? null,
            sourceLabel: entry.card.displayName,
            name: name?.trim() || null,
            task,
            startAt: startDate,
            endAt: endDate,
            intervalValue: ivValue,
            intervalUnit: ivUnit,
            timezone: tz,
            enabled: true,
          })
          .returning();
        registerSchedule(row);
        const next = nextFireAt(row);
        return {
          ok: true as const,
          scheduleId: row.id,
          nextRunAt: next ? next.toISOString() : null,
          message: `Schedule created. Next fire ${
            next ? `at ${next.toISOString()}` : "is unknown"
          }.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          {
            event: "create_schedule_failed",
            err: message,
            agent,
            userId: ctx.userId,
          },
          "create_schedule failed",
        );
        return { ok: false as const, error: message };
      }
    },
  });

  // Only the user's own schedules are visible.
  const listMySchedules = defineTool({
    name: "list_schedules",
    description:
      "List the user's schedules. Returns each schedule's id, target agent, task prompt, trigger spec (startAt / intervalValue / intervalUnit / endAt), timezone, enabled flag, and last-run timestamp.",
    parameters: z.object({}),
    execute: async () => {
      const rows = await db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.ownerId, ctx.userId));
      return {
        ok: true as const,
        schedules: rows.map((r) => ({
          id: r.id,
          name: r.name,
          agent: r.sourceLabel,
          task: r.task,
          startAt: r.startAt.toISOString(),
          endAt: r.endAt ? r.endAt.toISOString() : null,
          intervalValue: r.intervalValue,
          intervalUnit: r.intervalUnit,
          timezone: r.timezone,
          enabled: r.enabled,
          lastTriggeredAt: r.lastTriggeredAt
            ? r.lastTriggeredAt.toISOString()
            : null,
          lastError: r.lastError,
          nextRunAt: r.enabled ? nextFireAt(r)?.toISOString() ?? null : null,
        })),
      };
    },
  });

  // Partial update over create_schedule fields plus `enabled`.
  // Target agent and credential are NOT mutable — switching is a
  // different schedule (delete + create).
  // STRICTER THAN REST: past `startAt` is refused so the LLM can't
  // trigger a backfill; that stays a REST-only power move.
  const updateSchedule = defineTool({
    name: "update_schedule",
    description:
      "Update fields of an existing schedule by id, returned from `list_schedules`. Only the provided fields change; omit a field to leave it as-is. Pause a schedule by passing `enabled: false`, resume with `enabled: true`. Editing any of (`startAt`, `intervalValue`, `intervalUnit`, `endAt`) re-defines when the schedule fires next and clears its last-run history. To switch the schedule to a different agent, delete it and create a new one.",
    parameters: z.object({
      scheduleId: z
        .string()
        .describe("The schedule id (UUID) to update."),
      task: z
        .string()
        .min(1)
        .optional()
        .describe("New natural-language task / prompt for the agent."),
      startAt: z
        .string()
        .optional()
        .describe(
          "ISO-8601 datetime of the next first fire. Must be in the future.",
        ),
      intervalValue: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(
          "New positive integer multiplier for the recurrence. Pass `null` together with `intervalUnit: null` to convert a recurring schedule into a one-shot.",
        ),
      intervalUnit: z
        .enum(["minute", "hour", "day", "week", "month"])
        .nullable()
        .optional()
        .describe(
          "New calendar unit paired with `intervalValue`. Pass `null` together with `intervalValue: null` to convert to one-shot.",
        ),
      endAt: z
        .string()
        .nullable()
        .optional()
        .describe(
          "New ISO-8601 datetime cap for a recurring schedule, or `null` to remove the cap.",
        ),
      timezone: z
        .string()
        .min(1)
        .optional()
        .describe("New IANA timezone, e.g. 'America/New_York'."),
      name: z
        .string()
        .nullable()
        .optional()
        .describe(
          "New human-readable label. Pass `null` to clear; omit to keep current.",
        ),
      enabled: z
        .boolean()
        .optional()
        .describe("Pass `false` to pause the schedule, `true` to resume."),
    }),
    execute: async ({
      scheduleId,
      task,
      startAt,
      intervalValue,
      intervalUnit,
      endAt,
      timezone,
      name,
      enabled,
    }) => {
      const result = await applyScheduleUpdate(
        ctx.userId,
        scheduleId,
        {
          ...(task !== undefined ? { task } : {}),
          ...(startAt !== undefined ? { startAt: new Date(startAt) } : {}),
          ...(endAt !== undefined
            ? { endAt: endAt === null ? null : new Date(endAt) }
            : {}),
          ...(intervalValue !== undefined ? { intervalValue } : {}),
          ...(intervalUnit !== undefined ? { intervalUnit } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
          ...(name !== undefined ? { name: name?.trim() || null } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        },
        { requireFutureStartAt: true },
      );
      if (!result.ok) {
        return { ok: false as const, error: result.error };
      }
      const next = nextFireAt(result.row);
      return {
        ok: true as const,
        scheduleId: result.row.id,
        nextRunAt:
          result.row.enabled && next ? next.toISOString() : null,
        message: result.row.enabled
          ? `Schedule updated. Next fire ${
              next ? `at ${next.toISOString()}` : "is unknown"
            }.`
          : "Schedule updated and paused.",
      };
    },
  });

  // Hard-delete: row + in-process timer removed atomically.
  const deleteSchedule = defineTool({
    name: "delete_schedule",
    description:
      "Delete a schedule permanently by id, returned from `list_schedules`. The timer is stopped immediately; in-flight runs already triggered by the schedule continue to run. To pause a schedule without deleting it (so it can be resumed later), use `update_schedule` with `enabled: false` instead.",
    parameters: z.object({
      scheduleId: z
        .string()
        .describe("The schedule id (UUID) to delete."),
    }),
    execute: async ({ scheduleId }) => {
      const result = await db
        .delete(ScheduleTable)
        .where(
          and(
            eq(ScheduleTable.id, scheduleId),
            eq(ScheduleTable.ownerId, ctx.userId),
          ),
        )
        .returning({ id: ScheduleTable.id });
      if (result.length === 0) {
        return {
          ok: false as const,
          error: `No schedule '${scheduleId}' found for this user.`,
        };
      }
      unregisterSchedule(scheduleId);
      return {
        ok: true as const,
        scheduleId,
        message: "Schedule deleted.",
      };
    },
  });

  return {
    tools: [
      delegate,
      delegateAsync,
      getAgentDetails,
      createSchedule,
      listMySchedules,
      updateSchedule,
      deleteSchedule,
    ],
    catalogPromptBlock,
  };
}

/** Supervisor-only tools auto-bound on promote / removed on demote. */
export const SUPERVISOR_TOOL_NAMES: readonly string[] = [
  "delegate_to_agent",
  "delegate_async",
  "get_agent_details",
  "create_schedule",
  "list_schedules",
  "update_schedule",
  "delete_schedule",
] as const;

export const SUPERVISOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  SUPERVISOR_TOOL_NAMES,
);
