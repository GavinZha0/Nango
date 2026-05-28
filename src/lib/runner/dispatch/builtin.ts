/**
 * Built-in agent dispatch — server-only.
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

/** Classify a CopilotKit URL: returns `{agentId, action}` for
 *  user-perceived dispatches (`/agent/{id}/run|connect`); `null` for
 *  bookkeeping calls (`/info`, `/threads/*`). */
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
 * silently degrades — MCP borrow failure, model resolution error,
 * spec unavailable, etc. The runner persists these as `degraded`
 * rows in `entity_run_event` AFTER recordRunStart so admins can see
 * them on the run-forensics timeline.
 *
 * The "capability axis" (mcp_server / model / spec / supervisor) is
 * NOT stored separately — it's implicit in the `reason` prefix
 * (`mcp_*` / `model_*` / `spec_*` / `supervisor_*`). Same row shape
 * for all four sources.
 */
export interface CapabilityDegradation {
  /** Identifier of the failing thing: mcpServerId / agentId / model
   *  string (`<provider>/<model>`). Always present — every call site
   *  knows what it was trying to load. */
  ref: string;
  /** Human-readable name of the failing thing, or null when the
   *  thing is already gone (deleted MCP server, deleted agent,
   *  borrow failure where the config row vanished). Forensic
   *  best-effort — captured at write time from `provider.label` /
   *  `spec.name`. */
  refName: string | null;
  /** Short event tag mirroring the structured log line so admins
   *  can grep both surfaces with one term. */
  reason: string;
  /** Human-readable detail (typically `err.message`). */
  message: string;
}

export interface BuiltinAgentsMap {
  agents: Record<string, BuiltInAgent>;
  borrowed: BorrowRecord[];
  /** Per-agent build-time capability skips. Empty array when an
   *  agent built cleanly. */
  degradations: Map<string, CapabilityDegradation[]>;
  /** QUIRK: per-supervisor parent-run-id holder. Runner sets
   *  `current = run.id` after the entity_run row is created so
   *  `delegate_to_agent` sub-runs link back as children. */
  supervisorRunHolders: Map<string, ParentRunIdHolder>;
}

export interface BuiltinBuildContext {
  userId: string;
  /** Active orchestration mode. Only consulted for supervisor agents
   *  (mode suffix appended to the system prompt). Undefined falls
   *  back to the registry default (auto). */
  mode?: OrchestrationModeId;
}

/**
 * Resolve specs, borrow MCP providers, return `{id → BuiltInAgent}` +
 * borrow ledger.
 *
 * QUIRK: specs that fail to load are silently dropped (logged at
 * debug) — preserves "one bad agent does not break the listing"
 * behaviour. Same for skill load + model resolution failures and MCP
 * borrow failures (agent runs without the failing dep).
 *
 * Without `ctx`, supervisor tools are skipped (no user context →
 * `delegate_to_agent` would be ambiguous about ownership /
 * parent-run linkage).
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

  /** Per-agent degradation accumulator. Allocates a list lazily so
   *  `degradations.get(agentId)` is empty when the agent built clean. */
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
      // Bumped from debug → warn: a missing spec at build time is
      // user-visible (the agent disappears from the listing) and
      // worth surfacing without a log-level toggle.
      log.warn({ event: "spec_skip", agentId }, "spec unavailable; skipping");
      // refName is null: spec lookup just returned null, so we don't
      // have a name. Best-effort acceptable — spec_skip is by
      // definition "the agent disappeared".
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

          // Borrow succeeded but discovery may have failed earlier
          // (latched on the provider). Inspect health on EVERY borrow
          // so the user-visible degradation surface (entity_run_event
          // `degraded` rows) matches what the agent
          // actually sees — without this check, a provider stuck in
          // discovery-failed state is silent on every dispatch after
          // the first warmup.
          //
          // `tools()` is awaited so a still-warming-up provider gets
          // a chance to resolve before we judge its health.
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
              // Provider is alive — borrow succeeded, just discovery
              // failed. `label` is mirrored from McpServerConfig.label.
              refName: provider.label,
              reason,
              message,
            });

            // Evict the failed provider with a cooldown so subsequent
            // dispatches don't keep using a known-bad provider AND
            // don't pummel the upstream MCP server with reconnect
            // attempts on every chat turn. After the cooldown the
            // next borrow re-runs discovery against the server.
            // Fire-and-forget — eviction failures should never break
            // the current dispatch path.
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
          // Non-fatal: agent runs without this tool.
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
            // Borrow threw before we got a provider, so no label to
            // capture; loadConfig presumably failed → likely the
            // server row is gone or its credential is missing.
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
      // mcp_tool: not yet wired (single-tool granularity from an MCP server).
    }

    const skillSpecs: SkillSpec[] = await skillPool.getMany(skillIds);
    const skillsRuntime = buildSkillsRuntime({ specs: skillSpecs });
    // The data-source prompt block is built per-dispatch (no spec
    // cache yet) — one DB read on dataSourceIds, filters disabled
    // rows server-side, drops orphan ids silently.
    const dataSourcesRuntime =
      await buildDataSourcesPromptBlock(dataSourceIds);
    // Same per-dispatch approach for SSH hosts.
    const sshHostsRuntime =
      await buildSshHostsPromptBlock(sshServerIds);

    // Auto-mount tools based on bindings. Binding ANY data source
    // implies `extract_dataset_by_sql` — the tool itself is generic
    // (the source slug is a parameter), so we just need to expose
    // its factory output. We build it DIRECTLY here, not by routing
    // its slug through `buildBuiltinTools`, because the user-tickable
    // catalog (catalog.ts) intentionally does NOT carry this tool:
    // it auto-mounts on binding rather than being a free-standing
    // capability toggle, and routing through the catalog would just
    // get the slug dropped on lookup miss (drove past us silently
    // before the fix — see AGENTS.md §16).
    const dataSourceTools: ToolDefinition[] = dataSourceIds.length > 0
      ? [buildExtractDatasetTool()]
      : [];

    // Same auto-mount pattern for SSH: binding any ssh_server implies `run_ssh_command`.
    // And binding implies `list_ssh_hosts`.
    const sshTools: ToolDefinition[] = sshServerIds.length > 0
      ? [
          buildRunSshCommandTool({ agentSshServerIds: sshServerIds }),
          buildListSshHostsTool({ agentSshServerIds: sshServerIds }),
        ]
      : [];

    // Supervisor tools + catalog precompute.
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
          // Spec was loaded successfully (we got past the spec_skip
          // branch above), so its name is in scope.
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
    // Resolve user-selected built-in tools (run_code_in_sandbox,
    // web_search, …). Unknown names are dropped silently — a junction
    // row pointing at a retired tool name should not crash the run.
    // Binding-implied tools (extract_dataset_by_sql / run_ssh_command
    // / list_ssh_hosts / supervisor tools) do NOT come through this
    // path; they're built directly above based on the user's bindings.
    const builtinTools: ToolDefinition[] = buildBuiltinTools([...builtinToolNames]);

    // Chart prompt block — gates *behavioural* enablement of the
    // globally-registered render_chart frontend tool. Supervisors
    // get a "delegate, don't draw" block; every other non-supervisor
    // agent (including chat-only ones) gets the "encourage" usage
    // rules. `hasDataSource` / `hasSandbox` are accepted for future
    // binding-aware variants but unused in V1. See
    // docs/data-visualization.md §6.2.
    const chartPromptBlock: string = buildChartPromptBlock({
      hasDataSource: dataSourceIds.length > 0,
      hasSandbox: builtinToolNames.has("run_code_in_sandbox"),
      isSupervisor,
    });

    const hasTools: boolean =
      providers.length > 0
      || skillsRuntime.tools.length > 0
      || supervisorTools.length > 0
      || builtinTools.length > 0
      || dataSourceTools.length > 0
      || sshTools.length > 0;

    // Compose the final prompt: user prompt → skills/ds/ssh blocks →
    // chart block → supervisor catalog → tool-error policy → mode
    // directive (mode last so it stays adjacent to the user message
    // and keeps recency weight). The error policy is only injected
    // when the agent actually has tools — a tool-less agent can never
    // see an `isError: true` result so the policy text would be noise.
    const modeSuffix: string =
      isSupervisor && ctx?.mode
        ? resolveOrchestrationMode(ctx.mode).promptDirective
        : "";
    const composedPrompt: string | undefined = (() => {
      const parts: string[] = [];
      if (spec.prompt) parts.push(spec.prompt);
      if (skillsRuntime.promptBlock.length > 0) parts.push(skillsRuntime.promptBlock);
      if (dataSourcesRuntime.promptBlock.length > 0) parts.push(dataSourcesRuntime.promptBlock);
      if (sshHostsRuntime.promptBlock.length > 0) parts.push(sshHostsRuntime.promptBlock);
      if (chartPromptBlock.length > 0) parts.push(chartPromptBlock);
      if (supervisorCatalogBlock.length > 0) parts.push(supervisorCatalogBlock);
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
        // The ref `<provider>/<model>` is already a human-readable
        // string — no separate name to surface, so refName falls
        // back to ref on the UI side via the `refName ?? ref` rule.
        ref: `${spec.modelProvider}/${spec.model}`,
        refName: null,
        reason: "model_resolve_failed",
        message,
      });
      continue;
    }

    // Wrap every Class B/C server tool so an uncaught throw becomes a
    // `{ isError: true, ... }` return value instead of an AI SDK
    // `tool-error` part. CopilotKit 1.56's converter silently drops
    // `tool-error`, leaving the browser UI stuck on TOOL_CALL_END
    // without a matching TOOL_CALL_RESULT. MCP tools were already
    // wrapped at borrow time (lib/mcp/client-providers.ts → wrapTools),
    // so providers[] is left untouched here. See docs/diagrams/tool-lifecycle.html.
    const serverTools: ToolDefinition[] = [
      ...skillsRuntime.tools,
      ...supervisorTools,
      ...builtinTools,
      ...dataSourceTools,
      ...sshTools,
    ].map((t) => wrapToolExecute(t, t.name, log, "server_tool_failed"));

    agents[agentId] = new BuiltInAgent({
      model: resolvedModel.model,
      // `apiKey` is only meaningful when `model` is a string;
      // custom AI SDK instances embed their own auth.
      ...(resolvedModel.apiKey !== undefined ? { apiKey: resolvedModel.apiKey } : {}),
      ...(composedPrompt !== undefined ? { prompt: composedPrompt } : {}),
      ...(spec.temperature !== null ? { temperature: spec.temperature } : {}),
      ...(spec.maxTokens !== null ? { maxTokens: spec.maxTokens } : {}),
      toolChoice: spec.toolChoice,
      // QUIRK: maxSteps must be > 1 when tools are bound, otherwise
      // the agent calls a tool but has no remaining step to generate
      // a reply. Tool-less agents coerce to 1 for parity with
      // pre-refactor behaviour.
      maxSteps: hasTools ? spec.maxSteps : 1,
      // QUIRK: mcpClients (user-managed lifecycle) over mcpServers
      // (agent-managed) so the pool — not the runtime — owns
      // connection lifetime.
      ...(providers.length > 0 ? { mcpClients: providers } : {}),
      ...(serverTools.length > 0 ? { tools: serverTools } : {}),
    });
  }

  return { agents, borrowed, degradations, supervisorRunHolders };
}

/**
 * Persist build-time capability degradations as `degraded` rows in
 * `entity_run_event`, starting at `startSeq`. Returns the next
 * available seq (`startSeq + list.length`), which the caller chains
 * into `PersistingAgent.cfg.startSeq` so the agent's own stream
 * begins at the correct seq without colliding on (run_id, seq) PK.
 *
 * Best-effort: failures are logged and swallowed — degradation
 * tracking must NEVER cause a run to abort. On per-row failure the
 * loop continues to maximise the number of events persisted; the
 * return value is `startSeq + list.length` (including gaps) so the
 * agent stream starts at the correct seq boundary either way.
 *
 * @param startSeq — the first seq to assign. The caller writes the
 *   user-message event at seq 0 FIRST, then calls this with
 *   `startSeq = 1`, so the admin timeline reads as
 *   `user_message → degraded → started → ...` — matching the natural
 *   "user asked → system noticed these problems → agent began
 *   working" narrative.
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
  // Always return startSeq + list.length so the agent stream starts at the
  // correct seq boundary, even if some events failed to persist.
  return startSeq + list.length;
}

/** CONTRACT: release each borrow exactly once. Pool tolerates
 *  double-release defensively; one-shot ledger keeps refcount
 *  accounting auditable. */
export function releaseBuiltinBorrows(borrowed: BorrowRecord[]): void {
  for (const b of borrowed) {
    mcpProviderPool.release(b.serverId, b.provider);
  }
}
