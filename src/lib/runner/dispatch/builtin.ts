/**
 * Built-in agent dispatch — server-only.
 *
 * See docs/builtin-runtime.md and docs/orchestrator.md.
 */

import "server-only";

import { BuiltInAgent } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";

import { agentPool } from "@/lib/builtin-agents";
import { resolveLanguageModel } from "@/lib/builtin-agents/model-resolver";
import type { AgentSpec } from "@/lib/builtin-agents/agent-spec";
import { buildBuiltinTools } from "@/lib/builtin-tools";
import { buildDataSourcesPromptBlock } from "@/lib/data-sources/prompt-block.server";
import { buildExtractDatasetTool } from "@/lib/data-sources/runtime-tools";
import { buildGetCurrentDatetimeTool } from "@/lib/time/runtime-tools";
import { buildChartPromptBlock } from "@/lib/outcomes/prompt-block.server";
import { mcpProviderPool } from "@/lib/mcp";
import { buildSshHostsPromptBlock } from "@/lib/ssh/prompt-block.server";
import {
  buildListSshHostsTool,
  buildRunSshCommandTool,
} from "@/lib/ssh/runtime-tools";
import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";
import { skillPool, type SkillSpec } from "@/lib/skills";
import { buildSkillsRuntime } from "@/lib/skills/runtime-tools";
import type { childLogger } from "@/lib/observability/logger";
import { recordEvent } from "../event-store";
import {
  buildSupervisorRuntime,
  type ParentRunIdHolder,
  type SupervisorRuntime,
} from "../supervisor-tools.server";
import { ERROR_POLICY_BLOCK, wrapToolExecute } from "../tool-failure";
import {
  resolveOrchestrationMode,
  type OrchestrationModeId,
} from "@/lib/orchestration/modes";
import { SUPERVISOR_CONTRACT } from "@/lib/constants/supervisor";
import { SAFETY_POLICY_BLOCK } from "@/lib/constants/safety";

/** Classify a CopilotKit URL: `{agentId, action}` for user-perceived
 *  dispatches; `null` for bookkeeping calls. */
export function classifyBuiltinPath(
  pathname: string,
): { agentId: string; action: "run" | "connect" } | null {
  const run = pathname.match(/\/agent\/([^/]+)\/run\b/);
  if (run) return { agentId: run[1], action: "run" };
  const connect = pathname.match(/\/agent\/([^/]+)\/connect\b/);
  if (connect) return { agentId: connect[1], action: "connect" };
  return null;
}

/** Borrowed MCP provider + serverId for the release ledger. */
export interface BorrowRecord {
  serverId: string;
  provider: GracefulMcpProvider;
}

/**
 * Build-time capability skip. Emitted whenever `buildBuiltinAgents`
 * silently degrades (MCP borrow failure, model resolution, missing
 * spec, supervisor build, …). Persisted as `degraded` rows in
 * `entity_run_event` so admins can see them on the run timeline.
 *
 * Capability axis (mcp / model / spec / supervisor) is implicit in
 * the `reason` prefix.
 */
export interface CapabilityDegradation {
  /** Identifier of the failing thing: mcpServerId / agentId / model. */
  ref: string;
  /** Human-readable name, or null when the thing is already gone. */
  refName: string | null;
  /** Short event tag mirroring the structured log line. */
  reason: string;
  /** Detail — typically `err.message`. */
  message: string;
}

export interface BuiltinAgentsMap {
  agents: Record<string, BuiltInAgent>;
  borrowed: BorrowRecord[];
  /** Per-agent build-time capability skips. */
  degradations: Map<string, CapabilityDegradation[]>;
  /** Per-supervisor parent-run-id holder. Runner sets `current` after
   *  the entity_run row is created so `delegate_to_agent` sub-runs
   *  link back as children. */
  supervisorRunHolders: Map<string, ParentRunIdHolder>;
}

export interface BuiltinBuildContext {
  userId: string;
  /** Active orchestration mode. Only consulted for supervisor agents. */
  mode?: OrchestrationModeId;
}

/**
 * Resolve specs, borrow MCP providers, return `{id → BuiltInAgent}`
 * + borrow ledger. Failures (spec, skill, model, MCP borrow) are
 * dropped silently so one bad agent does not break the listing.
 *
 * Without `ctx`, supervisor tools are skipped (no user context →
 * `delegate_to_agent` would be ambiguous).
 */
export async function buildBuiltinAgents(
  agentIds: string[],
  log: ReturnType<typeof childLogger>,
  ctx?: BuiltinBuildContext,
): Promise<BuiltinAgentsMap> {
  const agents: Record<string, BuiltInAgent> = {};
  const borrowed: BorrowRecord[] = [];
  const degradations: Map<string, CapabilityDegradation[]> = new Map();
  const supervisorRunHolders: Map<string, ParentRunIdHolder> = new Map();

  const recordDegradation = (agentId: string, d: CapabilityDegradation): void => {
    let list = degradations.get(agentId);
    if (!list) {
      list = [];
      degradations.set(agentId, list);
    }
    list.push(d);
  };

  for (const agentId of agentIds) {
    const spec: AgentSpec | null = await agentPool.get(agentId);
    if (!spec) {
      log.warn({ event: "spec_skip", agentId }, "spec unavailable; skipping");
      recordDegradation(agentId, {
        ref: agentId,
        refName: null,
        reason: "spec_skip",
        message: "Agent spec unavailable (disabled, deleted, or invalid).",
      });
      continue;
    }

    const providers: GracefulMcpProvider[] = [];
    const skillIds: string[] = [];
    const builtinToolNames: Set<string> = new Set();
    const dataSourceIds: string[] = [];
    const sshServerIds: string[] = [];
    for (const tool of spec.tools) {
      if (tool.kind === "mcp_server") {
        try {
          const provider: GracefulMcpProvider = await mcpProviderPool.borrow(
            tool.mcpServerId,
          );
          borrowed.push({ serverId: tool.mcpServerId, provider });
          providers.push(provider);

          // Borrow can succeed while discovery latched earlier as
          // failed. Inspect health on every borrow so the user-visible
          // degradation surface matches what the agent actually sees.
          // `tools()` awaited so warming-up providers get a chance.
          await provider.tools();
          if (provider.health !== "ready") {
            const reason =
              provider.health === "discovery-timed-out"
                ? "mcp_discovery_timed_out"
                : "mcp_discovery_failed";
            const message =
              provider.lastErrorMessage ?? `MCP provider state: ${provider.health}`;
            log.warn(
              {
                event: reason,
                agentId,
                mcpServerId: tool.mcpServerId,
                providerHealth: provider.health,
                message,
              },
              "MCP discovery did not succeed; agent will run without these tools",
            );
            recordDegradation(agentId, {
              ref: tool.mcpServerId,
              refName: provider.label,
              reason,
              message,
            });

            // Evict with cooldown so subsequent dispatches don't keep
            // using a known-bad provider AND don't pummel the upstream
            // with reconnects every turn. Fire-and-forget.
            const mcpServerId = tool.mcpServerId;
            void mcpProviderPool.evictWithCooldown(mcpServerId).catch((e) => {
              log.warn(
                {
                  event: "mcp_evict_failed",
                  mcpServerId,
                  err: e instanceof Error ? { name: e.name, message: e.message } : String(e),
                },
                "evictWithCooldown failed; pool state may be inconsistent",
              );
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            {
              event: "mcp_borrow_failed",
              agentId,
              mcpServerId: tool.mcpServerId,
              err:
                err instanceof Error
                  ? { message: err.message, name: err.name }
                  : String(err),
            },
            "mcp borrow failed; agent will run without it",
          );
          recordDegradation(agentId, {
            ref: tool.mcpServerId,
            refName: null,
            reason: "mcp_borrow_failed",
            message,
          });
        }
      } else if (tool.kind === "skill") {
        skillIds.push(tool.skillId);
      } else if (tool.kind === "builtin_tool") {
        builtinToolNames.add(tool.name);
      } else if (tool.kind === "datasource") {
        dataSourceIds.push(tool.dataSourceId);
      } else if (tool.kind === "ssh_server") {
        sshServerIds.push(tool.sshServerId);
      }
      // mcp_tool: not yet wired (single-tool granularity).
    }

    const skillSpecs: SkillSpec[] = await skillPool.getMany(skillIds);
    const skillsRuntime = buildSkillsRuntime({ specs: skillSpecs });
    const dataSourcesRuntime =
      await buildDataSourcesPromptBlock(dataSourceIds);
    const sshHostsRuntime =
      await buildSshHostsPromptBlock(sshServerIds);

    // Binding any data source auto-mounts `extract_dataset_by_sql`.
    // Built directly (not through buildBuiltinTools) — the user-tickable
    // catalog deliberately omits it; routing through there would drop
    // the slug on lookup miss.
    const dataSourceTools: ToolDefinition[] = dataSourceIds.length > 0
      ? [buildExtractDatasetTool()]
      : [];

    // Binding any ssh_server auto-mounts run_ssh_command + list_ssh_hosts.
    const sshTools: ToolDefinition[] = sshServerIds.length > 0
      ? [
          buildRunSshCommandTool({ agentSshServerIds: sshServerIds }),
          buildListSshHostsTool({ agentSshServerIds: sshServerIds }),
        ]
      : [];

    // Ambient tools — mounted on EVERY built-in agent regardless of
    // bindings or user toggles. `get_current_datetime` lets any agent
    // read "now" in the user's timezone. `userId` is captured in the
    // closure; absent on some programmatic builds → server-tz fallback.
    const ambientTools: ToolDefinition[] = [
      buildGetCurrentDatetimeTool({ userId: ctx?.userId }),
    ];

    const supervisorTools: SupervisorRuntime["tools"] = [];
    let supervisorCatalogBlock = "";
    const isSupervisor = spec.isSupervisor;
    if (isSupervisor && ctx) {
      const holder: ParentRunIdHolder = {
        current: undefined,
        threadId: undefined,
      };
      supervisorRunHolders.set(agentId, holder);
      try {
        const rt = await buildSupervisorRuntime({
          userId: ctx.userId,
          supervisorAgentId: agentId,
          parentRunIdHolder: holder,
        });
        supervisorTools.push(...rt.tools);
        supervisorCatalogBlock = rt.catalogPromptBlock;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { event: "supervisor_build_failed", agentId, err: message },
          "supervisor runtime build failed; agent will run without delegation tools",
        );
        recordDegradation(agentId, {
          ref: agentId,
          refName: spec.name,
          reason: "supervisor_build_failed",
          message,
        });
      }
    } else if (isSupervisor && !ctx) {
      log.debug(
        { event: "supervisor_tools_skipped", agentId },
        "supervisor tools skipped: no user context (programmatic build)",
      );
    }
    // User-selected built-in tools. Unknown names are dropped — a
    // junction row pointing at a retired tool name must not crash.
    // Binding-implied tools are built directly above, not here.
    const builtinTools: ToolDefinition[] = buildBuiltinTools([...builtinToolNames]);

    // Chart prompt block — gates behavioural enablement of the
    // globally-registered render_chart frontend tool.
    // See docs/data-visualization.md.
    const chartPromptBlock: string = buildChartPromptBlock({
      hasDataSource: dataSourceIds.length > 0,
      hasSandbox: builtinToolNames.has("run_code_in_sandbox"),
      isSupervisor,
    });

    // Always true in practice — `ambientTools` is never empty. Kept as
    // a disjunction so the invariant still holds if ambient tools ever
    // become conditional. `maxSteps` below depends on this: a tool-only
    // turn (e.g. get_current_datetime) needs a step left to reply.
    const hasTools: boolean =
      providers.length > 0
      || skillsRuntime.tools.length > 0
      || supervisorTools.length > 0
      || builtinTools.length > 0
      || dataSourceTools.length > 0
      || sshTools.length > 0
      || ambientTools.length > 0;

    // Prompt composition (Markdown-sectioned). Every block self-heads
    // with its own `##` so we just join with blank lines. Order:
    //   1. SUPERVISOR_CONTRACT (supervisor only) — forced, immutable
    //      routing discipline.
    //   2. SAFETY_POLICY_BLOCK — forced for all agents; the closing
    //      override-clause raises its precedence over persona / user.
    //   3. user persona — spec.prompt wrapped in `## Persona`.
    //   4. supervisor catalog — the "Available agents" listing the
    //      CONTRACT references (placed after persona per the v3 design
    //      so identity/tone comes before the routing roster).
    //   5. capability blocks — skills / ds / ssh / chart.
    //   6. ERROR_POLICY_BLOCK — only when tools are present.
    //   7. mode directive (supervisor only) — LAST so the recency-
    //      weighting effect lands on per-turn routing constraints.
    const modeSuffix: string =
      isSupervisor && ctx?.mode
        ? resolveOrchestrationMode(ctx.mode).promptDirective
        : "";
    const composedPrompt: string | undefined = (() => {
      const parts: string[] = [];
      if (isSupervisor) parts.push(SUPERVISOR_CONTRACT);
      parts.push(SAFETY_POLICY_BLOCK);
      if (spec.prompt && spec.prompt.trim().length > 0) {
        parts.push(`## Persona\n\n${spec.prompt.trim()}`);
      }
      if (supervisorCatalogBlock.length > 0) {
        parts.push(supervisorCatalogBlock);
      }
      if (skillsRuntime.promptBlock.length > 0) {
        parts.push(skillsRuntime.promptBlock);
      }
      if (dataSourcesRuntime.promptBlock.length > 0) {
        parts.push(dataSourcesRuntime.promptBlock);
      }
      if (sshHostsRuntime.promptBlock.length > 0) {
        parts.push(sshHostsRuntime.promptBlock);
      }
      if (chartPromptBlock.length > 0) parts.push(chartPromptBlock);
      if (hasTools) parts.push(ERROR_POLICY_BLOCK);
      if (modeSuffix.length > 0) parts.push(modeSuffix);
      return parts.length === 0 ? undefined : parts.join("\n\n");
    })();

    let resolvedModel: ReturnType<typeof resolveLanguageModel>;
    try {
      resolvedModel = resolveLanguageModel(spec);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          event: "model_resolve_failed",
          agentId,
          modelProvider: spec.modelProvider,
          model: spec.model,
          err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
        },
        "model resolution failed; skipping agent",
      );
      recordDegradation(agentId, {
        ref: `${spec.modelProvider}/${spec.model}`,
        refName: null,
        reason: "model_resolve_failed",
        message,
      });
      continue;
    }

    // Wrap server tools so an uncaught throw becomes
    // `{ isError: true, ... }` instead of an AI SDK `tool-error`
    // that CopilotKit 1.56 drops. MCP tools are already wrapped at
    // borrow time, so providers[] is left untouched.
    const serverTools: ToolDefinition[] = [
      ...skillsRuntime.tools,
      ...supervisorTools,
      ...builtinTools,
      ...dataSourceTools,
      ...sshTools,
      ...ambientTools,
    ].map((t) => wrapToolExecute(t, t.name, log, "server_tool_failed"));

    agents[agentId] = new BuiltInAgent({
      model: resolvedModel.model,
      // apiKey only when model is a string — custom AI SDK instances
      // carry their own auth.
      ...(resolvedModel.apiKey !== undefined ? { apiKey: resolvedModel.apiKey } : {}),
      ...(composedPrompt !== undefined ? { prompt: composedPrompt } : {}),
      ...(spec.temperature !== null ? { temperature: spec.temperature } : {}),
      ...(spec.maxTokens !== null ? { maxTokens: spec.maxTokens } : {}),
      toolChoice: spec.toolChoice,
      // maxSteps MUST be > 1 when tools are bound; otherwise the agent
      // calls a tool with no step left to generate a reply. With the
      // ambient get_current_datetime making `hasTools` effectively
      // always-true, clamp to >= 2 so a user-set spec.maxSteps=1 can't
      // strand a tool call on the result.
      maxSteps: hasTools ? Math.max(spec.maxSteps, 2) : 1,
      // mcpClients (user-managed lifecycle) — pool owns connections.
      ...(providers.length > 0 ? { mcpClients: providers } : {}),
      ...(serverTools.length > 0 ? { tools: serverTools } : {}),
    });
  }

  return { agents, borrowed, degradations, supervisorRunHolders };
}

/**
 * Persist build-time capability degradations as `degraded` rows
 * starting at `startSeq`. Returns `startSeq + list.length` so the
 * agent's stream picks up at the next seq without PK collision.
 * Best-effort: per-row failures are logged and swallowed.
 *
 * The caller writes user_message at seq 0 first, then calls this
 * with `startSeq = 1` so the timeline reads
 * `user_message → degraded → started → …`.
 */
export async function recordCapabilityDegradations(
  runId: string,
  list: CapabilityDegradation[],
  log: ReturnType<typeof childLogger>,
  startSeq: number,
): Promise<number> {
  if (list.length === 0) return startSeq;
  for (let i = 0; i < list.length; i += 1) {
    const seq = startSeq + i;
    try {
      await recordEvent(runId, seq, "degraded", list[i]);
    } catch (err) {
      log.warn(
        {
          event: "degraded_write_failed",
          runId,
          seq,
          err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
        },
        "failed to persist degraded event; continuing",
      );
    }
  }
  return startSeq + list.length;
}

/** CONTRACT: release each borrow exactly once. */
export function releaseBuiltinBorrows(borrowed: BorrowRecord[]): void {
  for (const b of borrowed) {
    mcpProviderPool.release(b.serverId, b.provider);
  }
}
