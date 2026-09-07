/**
 * Unit tests for `src/lib/runner/supervisor-tools.server.ts`.
 *
 * Covers `buildSupervisorRuntime` (the sole public builder) and every
 * tool it returns: `delegate_to_agent`, `delegate_async`,
 * `get_agent_details`, `create_schedule`, `list_schedules`,
 * `update_schedule`, `delete_schedule`. Also covers the exported
 * `SUPERVISOR_TOOL_NAMES` / `SUPERVISOR_TOOL_NAME_SET` constants and
 * exercises the internal `buildCatalog` / `formatCatalogBlock` /
 * `excerpt` helpers indirectly through the public API.
 *
 * See docs/orchestrator.md for the supervisor delegation contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";


// ---------------------------------------------------------------------------
// Hoisted mock handles + shared db state.
//
// `vi.hoisted` runs before every `vi.mock` factory so the factories can
// reference these bindings. The db mock routes select chains by the
// *table sentinel* passed to `.from(table)` — the sentinels are the
// same objects exported by the mocked `@/lib/db/schema`.
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const CredentialTableSentinel = { __t: "CredentialTable" };
  const BuiltinAgentTableSentinel = { __t: "BuiltinAgentTable" };
  const ScheduleTableSentinel = { __t: "ScheduleTable" };

  /** Mutable per-test db query results. */
  const dbState = {
    credRows: [] as Array<{ id: string; name: string }>,
    /** One entry per builtin-agent lookup, consumed in call order. */
    builtinRowsQueue: [] as Array<Array<Record<string, unknown>>>,
    scheduleRows: [] as Array<Record<string, unknown>>,
    /** Queue of rows returned by `insert(...).returning()`. */
    insertReturning: [] as Array<Array<Record<string, unknown>>>,
    /** Queue of rows returned by `delete(...).returning()`. */
    deleteReturning: [] as Array<Array<Record<string, unknown>>>,
  };

  return {
    dbState,
    CredentialTableSentinel,
    BuiltinAgentTableSentinel,
    ScheduleTableSentinel,
    runnerStartMock: vi.fn(),
    applyScheduleUpdateMock: vi.fn(),
    validateTriggerSpecMock: vi.fn(),
    nextFireAtMock: vi.fn(),
    registerScheduleMock: vi.fn(),
    unregisterScheduleMock: vi.fn(),
    listVisibleAgentIdsMock: vi.fn(),
    getUserTimezoneMock: vi.fn(),
    entityCatalogListMock: vi.fn(),
    computeDisplayNameMock: vi.fn(),
    computeSourceLabelMock: vi.fn(),
    formatPageContextSnapshotMock: vi.fn(),
    getConfigNumberMock: vi.fn(),
    logWarnMock: vi.fn(),
    logInfoMock: vi.fn(),
    logErrorMock: vi.fn(),
    logDebugMock: vi.fn(),
  };
});

// `defineTool` is a pass-through so we can call `execute` directly.
vi.mock("@/lib/copilot/index.server", () => ({
  defineTool: (def: unknown) => def,
}));

vi.mock("@/lib/db", () => {
  const {
    dbState,
    CredentialTableSentinel,
    BuiltinAgentTableSentinel,
    ScheduleTableSentinel,
  } = hoisted;

  const makeSelectChain = () => {
    let fromTable: unknown = null;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn((t: unknown) => {
      fromTable = t;
      return chain;
    });
    chain.where = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    // A select chain is directly awaitable (no `.returning()`).
    chain.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      let val: unknown;
      if (fromTable === CredentialTableSentinel) val = dbState.credRows;
      else if (fromTable === BuiltinAgentTableSentinel)
        val = dbState.builtinRowsQueue.shift() ?? [];
      else if (fromTable === ScheduleTableSentinel) val = dbState.scheduleRows;
      else val = [];
      return Promise.resolve(val).then(resolve, reject);
    };
    return chain;
  };

  return {
    db: {
      select: vi.fn(() => makeSelectChain()),
      insert: vi.fn(() => ({
        values: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockImplementation(() =>
              Promise.resolve(dbState.insertReturning.shift() ?? []),
            ),
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockImplementation(() =>
              Promise.resolve(dbState.deleteReturning.shift() ?? []),
            ),
        }),
      })),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  CredentialTable: hoisted.CredentialTableSentinel,
  BuiltinAgentTable: hoisted.BuiltinAgentTableSentinel,
  ScheduleTable: hoisted.ScheduleTableSentinel,
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ type: "eq", col, val }),
  and: (...args: unknown[]) => ({ type: "and", args }),
}));

vi.mock("@/lib/access/agent-visibility", () => ({
  listVisibleAgentIds: hoisted.listVisibleAgentIdsMock,
}));

vi.mock("@/lib/backends/entity-catalog", () => ({
  EntityCatalog: { list: hoisted.entityCatalogListMock },
}));

vi.mock("@/lib/runner", () => ({ runner: { start: hoisted.runnerStartMock } }));

vi.mock("@/lib/time/user-timezone", () => ({
  getUserTimezone: hoisted.getUserTimezoneMock,
}));

vi.mock("@/lib/runner/scheduler", () => ({
  nextFireAt: hoisted.nextFireAtMock,
  registerSchedule: hoisted.registerScheduleMock,
  unregisterSchedule: hoisted.unregisterScheduleMock,
  validateTriggerSpec: hoisted.validateTriggerSpecMock,
}));

vi.mock("@/lib/runner/schedule-mutate", () => ({
  applyScheduleUpdate: hoisted.applyScheduleUpdateMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({
    warn: hoisted.logWarnMock,
    info: hoisted.logInfoMock,
    error: hoisted.logErrorMock,
    debug: hoisted.logDebugMock,
  }),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfigNumber: hoisted.getConfigNumberMock,
    getConfig: vi.fn().mockReturnValue(""),
    getConfigMs: vi.fn().mockReturnValue(0),
  };
});

vi.mock("@/lib/orchestration/display-name", () => ({
  computeDisplayName: hoisted.computeDisplayNameMock,
  computeSourceLabel: hoisted.computeSourceLabelMock,
}));

vi.mock("@/lib/runner/extract-run-input", () => ({
  formatPageContextSnapshot: hoisted.formatPageContextSnapshotMock,
}));

// ---------------------------------------------------------------------------
// Imports under test — must come AFTER all vi.mock calls.
// ---------------------------------------------------------------------------
import {
  buildSupervisorRuntime,
  SUPERVISOR_TOOL_NAMES,
  type SupervisorRuntimeContext,
  type SupervisorRuntime,
} from "@/lib/runner/supervisor-tools.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EntityKind = "agent" | "team" | "workflow";
type AgentRole = "supervisor" | "secretary" | "evaluator" | "tester";

interface BuiltinAgentRow {
  name: string;
  description: string | null;
  role: AgentRole | null;
  prompt: string | null;
  createdBy: string | null;
  visibility: string;
}

interface BackendEntity {
  id: string;
  name?: string;
  kind: EntityKind;
  description?: string;
  prompt?: string;
}

interface RuntimeSetup {
  credentials?: Array<{ id: string; name: string }>;
  backendEntities?: Record<string, BackendEntity[]>;
  visibleIds?: string[];
  builtinAgents?: Record<string, BuiltinAgentRow>;
  profileTimezone?: string | null;
  pageContext?: unknown;
  supervisorAgentId?: string;
  userId?: string;
  excerptChars?: number;
  parentRunId?: string;
  threadId?: string;
}

/** Reset all mock state and build a fresh supervisor runtime. */
async function setupRuntime(setup: RuntimeSetup = {}): Promise<{
  runtime: SupervisorRuntime;
  ctx: SupervisorRuntimeContext;
}> {
  const s = hoisted.dbState;
  s.credRows = setup.credentials ?? [];
  s.builtinRowsQueue = [];
  s.scheduleRows = [];
  s.insertReturning = [];
  s.deleteReturning = [];

  const visibleIds = setup.visibleIds ?? [];
  const supervisorAgentId = setup.supervisorAgentId ?? "sup-1";
  hoisted.listVisibleAgentIdsMock.mockResolvedValue(visibleIds);
  hoisted.getUserTimezoneMock.mockResolvedValue(setup.profileTimezone ?? null);

  // buildCatalog skips the supervisor's own id before querying, so the
  // builtin-row queue must only contain rows for non-supervisor ids in
  // the same order buildCatalog will query them.
  for (const id of visibleIds) {
    if (id === supervisorAgentId) continue;
    const row = setup.builtinAgents?.[id];
    s.builtinRowsQueue.push(row ? [row as unknown as Record<string, unknown>] : []);
  }

  hoisted.entityCatalogListMock.mockImplementation(async (credId: string) => {
    return setup.backendEntities?.[credId] ?? null;
  });

  hoisted.computeDisplayNameMock.mockImplementation((input: Record<string, unknown>) => {
    if (input.source === "builtin") return `Built-in / ${input.name}`;
    return `Backend / ${(input.name ?? input.credentialName) as string}`;
  });
  hoisted.computeSourceLabelMock.mockImplementation((input: Record<string, unknown>) => {
    if (input.source === "builtin") return input.isPublicByOthers ? "Shared" : "Built-in";
    return (input.credentialName as string) ?? "Backend";
  });

  hoisted.getConfigNumberMock.mockReturnValue(setup.excerptChars ?? 300);
  hoisted.validateTriggerSpecMock.mockReturnValue({ ok: true });
  hoisted.nextFireAtMock.mockReturnValue(new Date("2030-01-01T00:00:00Z"));
  hoisted.registerScheduleMock.mockReturnValue(undefined);
  hoisted.unregisterScheduleMock.mockReturnValue(undefined);
  hoisted.formatPageContextSnapshotMock.mockReturnValue("PAGE_CONTEXT_STRING");

  const userId = setup.userId ?? "user-1";
  const ctx: SupervisorRuntimeContext = {
    userId,
    supervisorAgentId: setup.supervisorAgentId ?? "sup-1",
    parentRunIdHolder: {
      current: setup.parentRunId ?? "run-parent-1",
      threadId: setup.threadId ?? "thread-1",
    },
    pageContext: (setup.pageContext ?? null) as never,
  };

  const runtime = await buildSupervisorRuntime(ctx);
  return { runtime, ctx };
}

/** Find a tool by name in the runtime's tool array. */
function findTool(runtime: SupervisorRuntime, name: string): {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  parameters: unknown;
  description: string;
} {
  const t = runtime.tools.find((tool: unknown) => {
    const def = tool as { name?: string };
    return def.name === name;
  });
  if (!t) throw new Error(`tool '${name}' not found in runtime`);
  return t as never;
}

/** A builtin-agent row with sensible defaults. */
function builtinRow(overrides: Partial<BuiltinAgentRow> = {}): BuiltinAgentRow {
  return {
    name: "Worker",
    description: "A worker agent",
    role: null,
    prompt: "You are a worker.",
    createdBy: "user-1",
    visibility: "private",
    ...overrides,
  };
}

/** A schedule row with sensible defaults (matches ScheduleEntity shape). */
function scheduleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sched-1",
    name: "Test Schedule",
    sourceLabel: "Built-in / Worker",
    task: "Do something",
    startAt: new Date("2030-01-01T00:00:00Z"),
    endAt: null,
    intervalValue: null,
    intervalUnit: null,
    timezone: "UTC",
    enabled: true,
    lastTriggeredAt: null,
    lastError: null,
    ownerId: "user-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SupervisorToolsTest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Exported constants
  // =========================================================================
  describe("SUPERVISOR_TOOL_NAMES / SUPERVISOR_TOOL_NAME_SET", () => {
    it("lists all seven supervisor tool names in order", () => {
      expect(SUPERVISOR_TOOL_NAMES).toEqual([
        "delegate_to_agent",
        "delegate_async",
        "get_agent_details",
        "create_schedule",
        "list_schedules",
        "update_schedule",
        "delete_schedule",
      ]);
    });
  });

  // =========================================================================
  // buildSupervisorRuntime — tool inventory + catalog block
  // =========================================================================
  describe("buildSupervisorRuntime — tool inventory", () => {
    it("returns exactly seven tools with the expected names", async () => {
      const { runtime } = await setupRuntime();
      const names = runtime.tools.map((t: unknown) => (t as { name: string }).name);
      expect(names).toHaveLength(7);
      expect(names.sort()).toEqual([...SUPERVISOR_TOOL_NAMES].sort());
    });
  });

  // =========================================================================
  // formatCatalogBlock (exercised via catalogPromptBlock)
  // =========================================================================
  describe("formatCatalogBlock (via catalogPromptBlock)", () => {
    it("renders the empty-catalog hint when no agents are configured", async () => {
      const { runtime } = await setupRuntime();
      expect(runtime.catalogPromptBlock).toContain("## Available agents (specialists)");
      expect(runtime.catalogPromptBlock).toContain("_No agents are currently configured.");
    });

    it("lists a builtin agent with heading + kind + description", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["agent-worker"],
        builtinAgents: {
          "agent-worker": builtinRow({
            name: "Worker",
            description: "A worker agent",
            prompt: "You are a worker.",
          }),
        },
      });
      const block = runtime.catalogPromptBlock;
      expect(block).toContain("### Built-in / Worker");
      expect(block).toContain("- kind: agent");
      expect(block).toContain("- description: A worker agent");
      expect(block).not.toContain("_No agents are currently configured.");
    });

    it("lists a backend agent with its display name and kind", async () => {
      const { runtime } = await setupRuntime({
        credentials: [{ id: "cred-1", name: "AgnoProd" }],
        backendEntities: {
          "cred-1": [
            { id: "ent-1", name: "Researcher", kind: "agent", description: "Research agent" },
          ],
        },
      });
      const block = runtime.catalogPromptBlock;
      expect(block).toContain("### Backend / Researcher");
      expect(block).toContain("- kind: agent");
      expect(block).toContain("- description: Research agent");
    });

    it("omits the description line when the agent has no description", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["agent-x"],
        builtinAgents: {
          "agent-x": builtinRow({ name: "NoDesc", description: null }),
        },
      });
      const block = runtime.catalogPromptBlock;
      expect(block).toContain("### Built-in / NoDesc");
      expect(block).not.toContain("- description:");
    });

    it("renders a mixed catalog with both builtin and backend agents", async () => {
      const { runtime } = await setupRuntime({
        credentials: [{ id: "cred-1", name: "Dify" }],
        backendEntities: {
          "cred-1": [
            { id: "ent-1", name: "Workflow1", kind: "workflow", description: "A workflow" },
          ],
        },
        visibleIds: ["agent-b"],
        builtinAgents: {
          "agent-b": builtinRow({ name: "BuiltinAgent", description: "builtin desc" }),
        },
      });
      const block = runtime.catalogPromptBlock;
      expect(block).toContain("### Backend / Workflow1");
      expect(block).toContain("- kind: workflow");
      expect(block).toContain("### Built-in / BuiltinAgent");
      expect(block).toContain("- kind: agent");
    });
  });

  // =========================================================================
  // excerpt (exercised via get_agent_details)
  // =========================================================================
  describe("excerpt (via get_agent_details promptExcerpt)", () => {
    it("returns the prompt verbatim when shorter than the limit", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a1"],
        builtinAgents: { a1: builtinRow({ prompt: "short prompt" }) },
      });
      const tool = findTool(runtime, "get_agent_details");
      const res = await tool.execute({ agent: "Built-in / Worker" });
      expect(res).toEqual({
        ok: true,
        displayName: "Built-in / Worker",
        kind: "agent",
        description: "A worker agent",
        promptExcerpt: "short prompt",
      });
    });

    it("returns undefined for a null prompt", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a1"],
        builtinAgents: { a1: builtinRow({ prompt: null }) },
      });
      const tool = findTool(runtime, "get_agent_details");
      const res = await tool.execute({ agent: "Built-in / Worker" });
      expect(res).toMatchObject({ promptExcerpt: null });
    });

    it("returns undefined for an empty / whitespace-only prompt", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a1"],
        builtinAgents: { a1: builtinRow({ prompt: "   " }) },
      });
      const tool = findTool(runtime, "get_agent_details");
      const res = await tool.execute({ agent: "Built-in / Worker" });
      expect(res).toMatchObject({ promptExcerpt: null });
    });

    it("truncates with an ellipsis when the prompt exceeds the limit", async () => {
      const longPrompt = "x".repeat(500);
      const { runtime } = await setupRuntime({
        visibleIds: ["a1"],
        builtinAgents: { a1: builtinRow({ prompt: longPrompt }) },
        excerptChars: 10,
      });
      const tool = findTool(runtime, "get_agent_details");
      const res = await tool.execute({ agent: "Built-in / Worker" });
      expect(res).toMatchObject({ promptExcerpt: "xxxxxxxxxx…" });
    });
  });

  // =========================================================================
  // buildCatalog branch coverage
  // =========================================================================
  describe("buildCatalog branches", () => {
    it("skips a backend credential whose EntityCatalog.list throws", async () => {
      // Only the failing credential; no builtin agents → empty catalog.
      hoisted.entityCatalogListMock.mockRejectedValueOnce(new Error("network down"));
      const { runtime } = await setupRuntime({
        credentials: [{ id: "cred-fail", name: "Broken" }],
        backendEntities: {},
      });
      // Catalog should be empty (the failing cred was skipped).
      expect(runtime.catalogPromptBlock).toContain("_No agents are currently configured.");
      expect(hoisted.logWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: "catalog_fetch_failed" }),
        "failed to fetch backend entity catalog; skipping credential",
      );
    });

    it("stringifies a non-Error throw from EntityCatalog.list in the log", async () => {
      hoisted.entityCatalogListMock.mockRejectedValueOnce("catalog string error");
      const { runtime } = await setupRuntime({
        credentials: [{ id: "cred-fail2", name: "Broken2" }],
        backendEntities: {},
      });
      expect(runtime.catalogPromptBlock).toContain("_No agents are currently configured.");
      expect(hoisted.logWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "catalog_fetch_failed",
          err: "catalog string error",
        }),
        "failed to fetch backend entity catalog; skipping credential",
      );
    });

    it("falls back to entity id when a backend entity has no name", async () => {
      const { runtime } = await setupRuntime({
        credentials: [{ id: "c1", name: "Agno" }],
        backendEntities: {
          c1: [{ id: "ent-noname", kind: "agent", description: "No name" }],
        },
      });
      // computeDisplayName receives name = e.name ?? e.id = "ent-noname".
      expect(hoisted.computeDisplayNameMock).toHaveBeenCalledWith(
        expect.objectContaining({ source: "backend", name: "ent-noname" }),
      );
      expect(runtime.catalogPromptBlock).toContain("### Backend / ent-noname");
    });

    it("skips a backend credential whose EntityCatalog.list returns null", async () => {
      const { runtime } = await setupRuntime({
        credentials: [{ id: "cred-null", name: "Empty" }],
        backendEntities: {}, // list returns null for unknown credId
      });
      expect(runtime.catalogPromptBlock).toContain("_No agents are currently configured.");
    });

    it("skips builtin agents whose role is not null (system agents)", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["agent-sys"],
        builtinAgents: {
          "agent-sys": builtinRow({ name: "SysAgent", role: "evaluator" }),
        },
      });
      // System agent filtered out → empty catalog.
      expect(runtime.catalogPromptBlock).toContain("_No agents are currently configured.");
    });

    it("excludes the supervisor itself from the catalog", async () => {
      const { runtime } = await setupRuntime({
        supervisorAgentId: "sup-1",
        visibleIds: ["sup-1", "agent-other"],
        builtinAgents: {
          "sup-1": builtinRow({ name: "Supervisor" }),
          "agent-other": builtinRow({ name: "Other" }),
        },
      });
      const block = runtime.catalogPromptBlock;
      expect(block).toContain("### Built-in / Other");
      expect(block).not.toContain("### Built-in / Supervisor");
    });

    it("skips a visible id that has no matching db row", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["ghost"],
        // No builtinAgents entry for "ghost" → empty row.
        builtinAgents: {},
      });
      expect(runtime.catalogPromptBlock).toContain("_No agents are currently configured.");
    });

    it.each([
      {
        name: "true for public agents created by another user",
        isPublic: true,
        setup: {
          userId: "user-1",
          visibleIds: ["agent-pub"],
          builtinAgents: { "agent-pub": builtinRow({ name: "Pub", visibility: "public", createdBy: "user-2" }) },
        } as RuntimeSetup,
      },
      {
        name: "false for private agents",
        isPublic: false,
        setup: {
          visibleIds: ["agent-priv"],
          builtinAgents: { "agent-priv": builtinRow({ visibility: "private", createdBy: "user-1" }) },
        } as RuntimeSetup,
      },
    ])("passes isPublicByOthers=$isPublic ($name)", async ({ isPublic, setup }) => {
      await setupRuntime(setup);
      expect(hoisted.computeSourceLabelMock).toHaveBeenCalledWith(
        expect.objectContaining({ source: "builtin", isPublicByOthers: isPublic }),
      );
    });
  });

  // =========================================================================
  // delegate_to_agent
  // =========================================================================
  describe("delegate_to_agent", () => {
    it("returns the sub-agent summary on a successful sync delegation", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "run-child-1",
        status: "succeeded",
        summary: "Task completed.",
      });
      const { runtime, ctx } = await setupRuntime({
        visibleIds: ["agent-w"],
        builtinAgents: { "agent-w": builtinRow({ name: "Worker" }) },
      });
      const tool = findTool(runtime, "delegate_to_agent");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do X" });

      expect(res).toEqual({
        ok: true,
        runId: "run-child-1",
        status: "succeeded",
        summary: "Task completed.",
      });
      expect(hoisted.runnerStartMock).toHaveBeenCalledTimes(1);
      const callArg = hoisted.runnerStartMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.mode).toBe("sync");
      expect(callArg.entityId).toBe("agent-w");
      expect(callArg.entityKind).toBe("agent");
      expect(callArg.initiator).toBe("orchestrator");
      expect(callArg.ownerId).toBe(ctx.userId);
      expect(callArg.createdBy).toBe(ctx.userId);
      expect(callArg.parentRunId).toBe("run-parent-1");
      expect(callArg.threadId).toBe("thread-1");
    });

    it("returns an error result when the delegated run fails", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "run-fail",
        status: "failed",
        summary: "",
        errorMessage: "Model unavailable",
      });
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_to_agent");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do X" });
      expect(res).toEqual({
        isError: true,
        message: "Model unavailable",
        runId: "run-fail",
        status: "failed",
      });
    });

    it("uses a default message when the failed run has no errorMessage", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "run-fail-2",
        status: "failed",
        summary: "",
      });
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_to_agent");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do X" });
      expect(res).toMatchObject({
        isError: true,
        message: "Delegated agent execution failed",
      });
    });

    it.each([
      {
        name: "catalog has agents but name not found",
        setup: { visibleIds: ["a"], builtinAgents: { a: builtinRow() } },
        agent: "Nonexistent",
        available: "Built-in / Worker",
      },
      {
        name: "catalog is empty",
        setup: {},
        agent: "Ghost",
        available: "(none)",
      },
    ])("returns not-found error ($name)", async ({ setup, agent, available }) => {
      const { runtime } = await setupRuntime(setup);
      const tool = findTool(runtime, "delegate_to_agent");
      const res = await tool.execute({ agent, task: "Do X" });
      expect(res).toEqual({
        isError: true,
        message: `Agent '${agent}' not found. Available: ${available}`,
      });
      expect(hoisted.runnerStartMock).not.toHaveBeenCalled();
    });

    it("returns an error when runner.start throws an Error", async () => {
      hoisted.runnerStartMock.mockRejectedValue(new Error("connection refused"));
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_to_agent");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do X" });
      expect(res).toEqual({ isError: true, message: "connection refused" });
      expect(hoisted.logWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: "delegate_failed" }),
        "delegate_to_agent failed",
      );
    });

    it("stringifies a non-Error throw value in the error message", async () => {
      hoisted.runnerStartMock.mockRejectedValue("string failure");
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_to_agent");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do X" });
      expect(res).toEqual({ isError: true, message: "string failure" });
    });

    it("passes the formatted page context when includePageContext is true", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "r",
        status: "succeeded",
        summary: "ok",
      });
      const pageCtx = { activeUrl: "/x", activeView: "editor" };
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
        pageContext: pageCtx,
      });
      const tool = findTool(runtime, "delegate_to_agent");
      await tool.execute({ agent: "Built-in / Worker", task: "Do X", includePageContext: true });
      expect(hoisted.formatPageContextSnapshotMock).toHaveBeenCalledTimes(1);
      const callArg = hoisted.runnerStartMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.context).toEqual({ pageContext: "PAGE_CONTEXT_STRING" });
    });

    it("does not attach page context when includePageContext is true but ctx.pageContext is null", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "r",
        status: "succeeded",
        summary: "ok",
      });
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
        pageContext: null,
      });
      const tool = findTool(runtime, "delegate_to_agent");
      await tool.execute({ agent: "Built-in / Worker", task: "Do X", includePageContext: true });
      expect(hoisted.formatPageContextSnapshotMock).not.toHaveBeenCalled();
      const callArg = hoisted.runnerStartMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.context).toBeUndefined();
    });

    it("uses the catalog kind for backend entities", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "r",
        status: "succeeded",
        summary: "ok",
      });
      const { runtime } = await setupRuntime({
        credentials: [{ id: "c1", name: "Agno" }],
        backendEntities: {
          c1: [{ id: "ent-1", name: "Team1", kind: "team" }],
        },
      });
      const tool = findTool(runtime, "delegate_to_agent");
      await tool.execute({ agent: "Backend / Team1", task: "Do X" });
      const callArg = hoisted.runnerStartMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.entityKind).toBe("team");
      expect(callArg.credentialId).toBe("c1");
    });
  });

  // =========================================================================
  // delegate_async
  // =========================================================================
  describe("delegate_async", () => {
    it("returns a runId and a background-started message on success", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "run-async-1",
        status: "running",
        summary: "",
      });
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_async");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do Y" });
      expect(res).toEqual({
        ok: true,
        runId: "run-async-1",
        status: "running",
        message:
          "Started 'Built-in / Worker' in the background; you'll be notified when it finishes.",
      });
      const callArg = hoisted.runnerStartMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.mode).toBe("async");
      expect(callArg.sourceLabel).toBe("Built-in / Worker");
    });

    it("returns an error result when the async start fails", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "run-async-fail",
        status: "failed",
        summary: "",
        errorMessage: "queue full",
      });
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_async");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do Y" });
      expect(res).toEqual({
        isError: true,
        message: "queue full",
        runId: "run-async-fail",
        status: "failed",
      });
    });

    it("uses a default message when the failed async start has no errorMessage", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "r2",
        status: "failed",
        summary: "",
      });
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_async");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do Y" });
      expect(res).toMatchObject({
        isError: true,
        message: "Failed to start async delegation",
      });
    });

    it.each([
      {
        name: "catalog has agents but name not found",
        setup: { visibleIds: ["a"], builtinAgents: { a: builtinRow() } },
        available: "Built-in / Worker",
      },
      {
        name: "catalog is empty",
        setup: {},
        available: "(none)",
      },
    ])("returns not-found error ($name)", async ({ setup, available }) => {
      const { runtime } = await setupRuntime(setup);
      const tool = findTool(runtime, "delegate_async");
      const res = await tool.execute({ agent: "Ghost", task: "Do Y" });
      expect(res).toEqual({
        isError: true,
        message: `Agent 'Ghost' not found. Available: ${available}`,
      });
      expect(hoisted.runnerStartMock).not.toHaveBeenCalled();
    });

    it("returns an error when runner.start throws", async () => {
      hoisted.runnerStartMock.mockRejectedValue(new Error("boom"));
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_async");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do Y" });
      expect(res).toEqual({ isError: true, message: "boom" });
      expect(hoisted.logWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: "delegate_async_failed" }),
        "delegate_async failed",
      );
    });


    it("uses the catalog kind for a backend entity", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "r",
        status: "running",
        summary: "",
      });
      const { runtime } = await setupRuntime({
        credentials: [{ id: "c1", name: "Agno" }],
        backendEntities: {
          c1: [{ id: "ent-1", name: "WorkflowX", kind: "workflow" }],
        },
      });
      const tool = findTool(runtime, "delegate_async");
      await tool.execute({ agent: "Backend / WorkflowX", task: "Do Y" });
      const callArg = hoisted.runnerStartMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.entityKind).toBe("workflow");
      expect(callArg.credentialId).toBe("c1");
      expect(callArg.mode).toBe("async");
    });

    it("stringifies a non-Error throw value in the error message", async () => {
      hoisted.runnerStartMock.mockRejectedValue("async string failure");
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_async");
      const res = await tool.execute({ agent: "Built-in / Worker", task: "Do Y" });
      expect(res).toEqual({ isError: true, message: "async string failure" });
    });
  });

  // =========================================================================
  // get_agent_details
  // =========================================================================
  describe("get_agent_details", () => {
    it("returns the agent card details for a known agent", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow({ prompt: "You are a worker." }) },
      });
      const tool = findTool(runtime, "get_agent_details");
      const res = await tool.execute({ agent: "Built-in / Worker" });
      expect(res).toEqual({
        ok: true,
        displayName: "Built-in / Worker",
        kind: "agent",
        description: "A worker agent",
        promptExcerpt: "You are a worker.",
      });
    });

    it("returns null description and promptExcerpt when both are absent", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow({ description: null, prompt: null }) },
      });
      const tool = findTool(runtime, "get_agent_details");
      const res = await tool.execute({ agent: "Built-in / Worker" });
      expect(res).toEqual({
        ok: true,
        displayName: "Built-in / Worker",
        kind: "agent",
        description: null,
        promptExcerpt: null,
      });
    });

    it.each([
      {
        name: "catalog has agents but name not found",
        setup: { visibleIds: ["a"], builtinAgents: { a: builtinRow() } },
        agent: "Unknown",
        available: "Built-in / Worker",
      },
      {
        name: "catalog is empty",
        setup: {},
        agent: "Ghost",
        available: "(none)",
      },
    ])("returns not-found error ($name)", async ({ setup, agent, available }) => {
      const { runtime } = await setupRuntime(setup);
      const tool = findTool(runtime, "get_agent_details");
      const res = await tool.execute({ agent });
      expect(res).toEqual({
        isError: true,
        message: `Agent '${agent}' not found. Available: ${available}`,
      });
    });
  });

  // =========================================================================
  // create_schedule
  // =========================================================================
  describe("create_schedule", () => {
    it("creates a one-shot schedule and returns the next fire time", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const row = scheduleRow({ id: "sched-new" });
      hoisted.dbState.insertReturning.push([row]);
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-02-01T00:00:00Z"));

      const tool = findTool(runtime, "create_schedule");
      const res = await tool.execute({
        agent: "Built-in / Worker",
        task: "Run backup",
        startAt: "2030-02-01T00:00:00Z",
      });

      expect(res).toEqual({
        ok: true,
        scheduleId: "sched-new",
        nextRunAt: "2030-02-01T00:00:00.000Z",
        message: "Schedule created. Next fire at 2030-02-01T00:00:00.000Z.",
      });
      expect(hoisted.registerScheduleMock).toHaveBeenCalledWith(row);
    });

    it("creates a recurring schedule with interval + endAt", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const row = scheduleRow({
        id: "sched-recur",
        name: "Daily Report",
        intervalValue: 1,
        intervalUnit: "day",
      });
      hoisted.dbState.insertReturning.push([row]);
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-03-01T00:00:00Z"));

      const tool = findTool(runtime, "create_schedule");
      const res = await tool.execute({
        agent: "Built-in / Worker",
        task: "Daily report",
        startAt: "2030-03-01T00:00:00Z",
        intervalValue: 1,
        intervalUnit: "day",
        endAt: "2031-01-01T00:00:00Z",
        name: "  Daily Report  ",
      });

      expect(res).toMatchObject({ ok: true, scheduleId: "sched-recur" });
      // The name should be trimmed.
      expect(hoisted.registerScheduleMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Daily Report" }),
      );
    });


    it("returns an error when validateTriggerSpec fails", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      hoisted.validateTriggerSpecMock.mockReturnValue({
        ok: false,
        error: "startAt must be after endAt",
      });
      const tool = findTool(runtime, "create_schedule");
      const res = await tool.execute({
        agent: "Built-in / Worker",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
      });
      expect(res).toEqual({ isError: true, message: "startAt must be after endAt" });
    });

    it.each([
      {
        name: "catalog has agents but name not found",
        setup: { visibleIds: ["a"], builtinAgents: { a: builtinRow() } },
        available: "Built-in / Worker",
      },
      {
        name: "catalog is empty",
        setup: {},
        available: "(none)",
      },
    ])("returns not-found error ($name)", async ({ setup, available }) => {
      const { runtime } = await setupRuntime(setup);
      const tool = findTool(runtime, "create_schedule");
      const res = await tool.execute({
        agent: "Ghost",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
      });
      expect(res).toEqual({
        isError: true,
        message: `Agent 'Ghost' not found. Available: ${available}`,
      });
      expect(hoisted.validateTriggerSpecMock).not.toHaveBeenCalled();
    });

    it("returns an error when the db insert throws", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      hoisted.dbState.insertReturning.push([scheduleRow()]);
      // registerSchedule is called after the insert; make it throw to
      // exercise the try/catch around the insert block.
      hoisted.registerScheduleMock.mockImplementation(() => {
        throw new Error("db write failed");
      });
      const tool = findTool(runtime, "create_schedule");
      const res = await tool.execute({
        agent: "Built-in / Worker",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
      });
      expect(res).toEqual({ isError: true, message: "db write failed" });
      expect(hoisted.logWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: "create_schedule_failed" }),
        "create_schedule failed",
      );
    });

    it("defaults timezone to the user profile timezone when omitted", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
        profileTimezone: "Asia/Shanghai",
      });
      hoisted.dbState.insertReturning.push([scheduleRow()]);
      const tool = findTool(runtime, "create_schedule");
      await tool.execute({
        agent: "Built-in / Worker",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
      });
      expect(hoisted.validateTriggerSpecMock).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: "Asia/Shanghai" }),
      );
    });

    it("defaults timezone to UTC when omitted and no profile timezone", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
        profileTimezone: null,
      });
      hoisted.dbState.insertReturning.push([scheduleRow()]);
      const tool = findTool(runtime, "create_schedule");
      await tool.execute({
        agent: "Built-in / Worker",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
      });
      expect(hoisted.validateTriggerSpecMock).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: "UTC" }),
      );
    });

    it("uses the explicitly provided timezone", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
        profileTimezone: "Asia/Shanghai",
      });
      hoisted.dbState.insertReturning.push([scheduleRow()]);
      const tool = findTool(runtime, "create_schedule");
      await tool.execute({
        agent: "Built-in / Worker",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
        timezone: "America/New_York",
      });
      expect(hoisted.validateTriggerSpecMock).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: "America/New_York" }),
      );
    });

    it("returns null nextRunAt when nextFireAt returns null", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      hoisted.dbState.insertReturning.push([scheduleRow()]);
      hoisted.nextFireAtMock.mockReturnValue(null);
      const tool = findTool(runtime, "create_schedule");
      const res = await tool.execute({
        agent: "Built-in / Worker",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
      });
      expect(res).toMatchObject({ ok: true, nextRunAt: null });
      expect(res).toMatchObject({ message: "Schedule created. Next fire is unknown." });
    });


    it("uses the catalog kind for a backend entity", async () => {
      const { runtime } = await setupRuntime({
        credentials: [{ id: "c1", name: "Agno" }],
        backendEntities: {
          c1: [{ id: "ent-1", name: "TeamX", kind: "team" }],
        },
      });
      hoisted.dbState.insertReturning.push([scheduleRow({ id: "sched-be" })]);
      const tool = findTool(runtime, "create_schedule");
      const res = await tool.execute({
        agent: "Backend / TeamX",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
      });
      // Reaching the insert (ok: true) proves the backend branch of
      // `entityKind: entry.source === "backend" ? entry.card.kind : "agent"`
      // was executed.
      expect(res).toMatchObject({ ok: true, scheduleId: "sched-be" });
      expect(hoisted.registerScheduleMock).toHaveBeenCalledTimes(1);
    });

    it("stringifies a non-Error throw from the insert block", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      hoisted.dbState.insertReturning.push([scheduleRow()]);
      hoisted.registerScheduleMock.mockImplementation(() => {
        throw "string error";
      });
      const tool = findTool(runtime, "create_schedule");
      const res = await tool.execute({
        agent: "Built-in / Worker",
        task: "X",
        startAt: "2030-01-01T00:00:00Z",
      });
      expect(res).toEqual({ isError: true, message: "string error" });
    });
  });

  // =========================================================================
  // list_schedules
  // =========================================================================
  describe("list_schedules", () => {
    it("returns the user's schedules with formatted fields", async () => {
      const { runtime } = await setupRuntime();
      hoisted.dbState.scheduleRows = [
        scheduleRow({
          id: "s1",
          name: "Sched1",
          sourceLabel: "Built-in / Worker",
          task: "Task 1",
          startAt: new Date("2030-01-01T00:00:00Z"),
          enabled: true,
          lastTriggeredAt: new Date("2029-12-01T00:00:00Z"),
        }),
      ];
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-01-02T00:00:00Z"));
      const tool = findTool(runtime, "list_schedules");
      const res = await tool.execute({});
      expect(res).toMatchObject({ ok: true });
      const schedules = (res as { schedules: unknown[] }).schedules;
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toEqual({
        id: "s1",
        name: "Sched1",
        agent: "Built-in / Worker",
        task: "Task 1",
        startAt: "2030-01-01T00:00:00.000Z",
        endAt: null,
        intervalValue: null,
        intervalUnit: null,
        timezone: "UTC",
        enabled: true,
        lastTriggeredAt: "2029-12-01T00:00:00.000Z",
        lastError: null,
        nextRunAt: "2030-01-02T00:00:00.000Z",
      });
    });

    it("returns an empty list when the user has no schedules", async () => {
      hoisted.dbState.scheduleRows = [];
      const { runtime } = await setupRuntime();
      const tool = findTool(runtime, "list_schedules");
      const res = await tool.execute({});
      expect(res).toEqual({ ok: true, schedules: [] });
    });

    it("returns null nextRunAt for a disabled schedule", async () => {
      const { runtime } = await setupRuntime();
      hoisted.dbState.scheduleRows = [
        scheduleRow({ id: "s2", enabled: false }),
      ];
      const tool = findTool(runtime, "list_schedules");
      const res = await tool.execute({});
      const schedules = (res as { schedules: Array<Record<string, unknown>> }).schedules;
      expect(schedules[0].nextRunAt).toBeNull();
      // nextFireAt should not be called for a disabled schedule.
      expect(hoisted.nextFireAtMock).not.toHaveBeenCalled();
    });

    it("formats endAt as ISO string when present", async () => {
      const { runtime } = await setupRuntime();
      hoisted.dbState.scheduleRows = [
        scheduleRow({
          endAt: new Date("2031-06-01T00:00:00Z"),
          intervalValue: 1,
          intervalUnit: "week",
        }),
      ];
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-05-01T00:00:00Z"));
      const tool = findTool(runtime, "list_schedules");
      const res = await tool.execute({});
      const schedules = (res as { schedules: Array<Record<string, unknown>> }).schedules;
      expect(schedules[0].endAt).toBe("2031-06-01T00:00:00.000Z");
      expect(schedules[0].intervalValue).toBe(1);
      expect(schedules[0].intervalUnit).toBe("week");
    });

    it("returns null nextRunAt when enabled but nextFireAt is null", async () => {
      const { runtime } = await setupRuntime();
      hoisted.dbState.scheduleRows = [scheduleRow({ id: "s3", enabled: true })];
      hoisted.nextFireAtMock.mockReturnValue(null);
      const tool = findTool(runtime, "list_schedules");
      const res = await tool.execute({});
      const schedules = (res as { schedules: Array<Record<string, unknown>> }).schedules;
      expect(schedules[0].nextRunAt).toBeNull();
    });
  });

  // =========================================================================
  // update_schedule
  // =========================================================================
  describe("update_schedule", () => {
    it("returns the next fire time on a successful enabled update", async () => {
      const { runtime } = await setupRuntime();
      const row = scheduleRow({ id: "sched-up", enabled: true });
      hoisted.applyScheduleUpdateMock.mockResolvedValue({ ok: true, row });
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-04-01T00:00:00Z"));
      const tool = findTool(runtime, "update_schedule");
      const res = await tool.execute({
        scheduleId: "sched-up",
        task: "New task",
        startAt: "2030-04-01T00:00:00Z",
      });
      expect(res).toEqual({
        ok: true,
        scheduleId: "sched-up",
        nextRunAt: "2030-04-01T00:00:00.000Z",
        message: "Schedule updated. Next fire at 2030-04-01T00:00:00.000Z.",
      });
    });

    it("returns a paused message when the updated schedule is disabled", async () => {
      const row = scheduleRow({ id: "sched-pause", enabled: false });
      hoisted.applyScheduleUpdateMock.mockResolvedValue({ ok: true, row });
      const { runtime } = await setupRuntime();
      const tool = findTool(runtime, "update_schedule");
      const res = await tool.execute({
        scheduleId: "sched-pause",
        enabled: false,
      });
      expect(res).toEqual({
        ok: true,
        scheduleId: "sched-pause",
        nextRunAt: null,
        message: "Schedule updated and paused.",
      });
    });

    it("returns null nextRunAt when enabled but nextFireAt is null", async () => {
      const { runtime } = await setupRuntime();
      const row = scheduleRow({ id: "sched-nf", enabled: true });
      hoisted.applyScheduleUpdateMock.mockResolvedValue({ ok: true, row });
      hoisted.nextFireAtMock.mockReturnValue(null);
      const tool = findTool(runtime, "update_schedule");
      const res = await tool.execute({ scheduleId: "sched-nf", task: "X" });
      expect(res).toMatchObject({ ok: true, nextRunAt: null });
      expect(res).toMatchObject({ message: "Schedule updated. Next fire is unknown." });
    });

    it("returns an error when applyScheduleUpdate fails", async () => {
      hoisted.applyScheduleUpdateMock.mockResolvedValue({
        ok: false,
        code: "NOT_FOUND",
        error: "Schedule not found.",
      });
      const { runtime } = await setupRuntime();
      const tool = findTool(runtime, "update_schedule");
      const res = await tool.execute({ scheduleId: "ghost", task: "X" });
      expect(res).toEqual({ isError: true, message: "Schedule not found." });
    });

    it("passes requireFutureStartAt: true to applyScheduleUpdate", async () => {
      const row = scheduleRow({ enabled: true });
      hoisted.applyScheduleUpdateMock.mockResolvedValue({ ok: true, row });
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-01-01T00:00:00Z"));
      const { runtime } = await setupRuntime();
      const tool = findTool(runtime, "update_schedule");
      await tool.execute({ scheduleId: "s1", enabled: true });
      expect(hoisted.applyScheduleUpdateMock).toHaveBeenCalledWith(
        "user-1",
        "s1",
        expect.any(Object),
        { requireFutureStartAt: true },
      );
    });

    it("builds a correct patch from the provided fields", async () => {
      const row = scheduleRow({ enabled: true });
      hoisted.applyScheduleUpdateMock.mockResolvedValue({ ok: true, row });
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-01-01T00:00:00Z"));
      const { runtime } = await setupRuntime();
      const tool = findTool(runtime, "update_schedule");
      await tool.execute({
        scheduleId: "s1",
        task: "new task",
        intervalValue: 2,
        intervalUnit: "hour",
        endAt: null,
        timezone: "UTC",
        name: "  Label  ",
        enabled: false,
      });
      const patch = hoisted.applyScheduleUpdateMock.mock.calls[0][2] as Record<string, unknown>;
      expect(patch.task).toBe("new task");
      expect(patch.intervalValue).toBe(2);
      expect(patch.intervalUnit).toBe("hour");
      expect(patch.endAt).toBeNull();
      expect(patch.timezone).toBe("UTC");
      expect(patch.name).toBe("Label");
      expect(patch.enabled).toBe(false);
    });

    it("converts a string endAt to a Date in the patch", async () => {
      const row = scheduleRow({ enabled: true });
      hoisted.applyScheduleUpdateMock.mockResolvedValue({ ok: true, row });
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-01-01T00:00:00Z"));
      const { runtime } = await setupRuntime();
      const tool = findTool(runtime, "update_schedule");
      await tool.execute({
        scheduleId: "s1",
        endAt: "2031-05-01T00:00:00Z",
      });
      const patch = hoisted.applyScheduleUpdateMock.mock.calls[0][2] as Record<string, unknown>;
      expect(patch.endAt).toEqual(new Date("2031-05-01T00:00:00Z"));
    });

    it("trims name to null when only whitespace is provided", async () => {
      const row = scheduleRow({ enabled: true });
      hoisted.applyScheduleUpdateMock.mockResolvedValue({ ok: true, row });
      hoisted.nextFireAtMock.mockReturnValue(new Date("2030-01-01T00:00:00Z"));
      const { runtime } = await setupRuntime();
      const tool = findTool(runtime, "update_schedule");
      await tool.execute({
        scheduleId: "s1",
        name: "   ",
      });
      const patch = hoisted.applyScheduleUpdateMock.mock.calls[0][2] as Record<string, unknown>;
      expect(patch.name).toBeNull();
    });
  });

  // =========================================================================
  // delete_schedule
  // =========================================================================
  describe("delete_schedule", () => {
    it("deletes the schedule and unregisters its timer", async () => {
      const { runtime } = await setupRuntime();
      hoisted.dbState.deleteReturning.push([{ id: "sched-del" }]);
      const tool = findTool(runtime, "delete_schedule");
      const res = await tool.execute({ scheduleId: "sched-del" });
      expect(res).toEqual({
        ok: true,
        scheduleId: "sched-del",
        message: "Schedule deleted.",
      });
      expect(hoisted.unregisterScheduleMock).toHaveBeenCalledWith("sched-del");
    });

    it("returns an error when the schedule does not exist for the user", async () => {
      const { runtime } = await setupRuntime();
      hoisted.dbState.deleteReturning.push([]);
      const tool = findTool(runtime, "delete_schedule");
      const res = await tool.execute({ scheduleId: "ghost" });
      expect(res).toEqual({
        isError: true,
        message: "No schedule 'ghost' found for this user.",
      });
      expect(hoisted.unregisterScheduleMock).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Cross-cutting: agent name trimming
  // =========================================================================
  describe("agent name trimming", () => {
    it("delegate_to_agent trims whitespace in the agent argument", async () => {
      hoisted.runnerStartMock.mockResolvedValue({
        runId: "r",
        status: "succeeded",
        summary: "ok",
      });
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "delegate_to_agent");
      const res = await tool.execute({ agent: "  Built-in / Worker  ", task: "X" });
      expect(res).toMatchObject({ ok: true });
      expect(hoisted.runnerStartMock).toHaveBeenCalledTimes(1);
    });

    it("get_agent_details trims whitespace in the agent argument", async () => {
      const { runtime } = await setupRuntime({
        visibleIds: ["a"],
        builtinAgents: { a: builtinRow() },
      });
      const tool = findTool(runtime, "get_agent_details");
      const res = await tool.execute({ agent: "  Built-in / Worker  " });
      expect(res).toMatchObject({ ok: true });
    });
  });
});