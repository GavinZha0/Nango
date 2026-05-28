import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  BuiltinAgentTable: {
    id: "id",
    enabled: "enabled",
    credentialId: "credential_id",
    modelProvider: "model_provider",
    model: "model",
    prompt: "prompt",
    temperature: "temperature",
    maxTokens: "max_tokens",
    maxSteps: "max_steps",
    toolChoice: "tool_choice",
  },
  BuiltinAgentToolTable: {
    agentId: "agent_id",
    toolType: "tool_type",
    mcpServerId: "mcp_server_id",
    mcpToolName: "mcp_tool_name",
    skillId: "skill_id",
    builtinTool: "builtin_tool",
    order: "order",
  },
}));

vi.mock("@/lib/credentials/lookup", () => ({
  getCredentialConfigById: vi.fn(),
}));

const { AgentPool, defaultLoadAgentSpec } = await import("@/lib/builtin-agents/agent-pool");
import type { AgentSpecLoader } from "@/lib/builtin-agents/agent-pool";
import type { AgentSpec } from "@/lib/builtin-agents/agent-spec";
const { db } = await import("@/lib/db");
const { getCredentialConfigById } = await import("@/lib/credentials/lookup");

// ── Helpers ────────────────────────────────────────────────────────────────────

interface AgentRowDb {
  id: string;
  name: string;
  modelProvider: string;
  model: string;
  prompt: string | null;
  temperature: string | null;
  maxTokens: number | null;
  maxSteps: number;
  toolChoice: string;
  credentialId: string;
}

interface ToolRowDb {
  toolType: string;
  mcpServerId: string | null;
  mcpToolName: string | null;
  skillId: string | null;
  builtinTool: string | null;
}

/**
 * Drizzle's chained-builder shape for the loader is, in order:
 *
 *   1) db.select(...).from(...).where(...).limit(1)             — agent row
 *   2) db.select(...).from(...).where(...)                      — credentialId reverse lookup (invalidateByCredential)
 *   3) db.select(...).from(...).where(...).orderBy(...)         — tool rows
 *
 * Stub each .select() call in sequence by feeding a list of result sets.
 * Each entry decides whether the chain terminates with `.limit(1)`,
 * `.orderBy(...)`, or just `.where(...)`.
 */
type ChainResult =
  | { kind: "limit"; rows: unknown[] }
  | { kind: "orderBy"; rows: unknown[] }
  | { kind: "where"; rows: unknown[] };

function mockSelectChain(results: ChainResult[]): void {
  const fn = vi.mocked(db.select);
  fn.mockReset();
  for (const r of results) {
    fn.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where:
          r.kind === "where"
            ? vi.fn().mockResolvedValue(r.rows)
            : vi.fn().mockReturnValue(
                r.kind === "limit"
                  ? { limit: vi.fn().mockResolvedValue(r.rows) }
                  : { orderBy: vi.fn().mockResolvedValue(r.rows) },
              ),
      }),
    } as unknown as ReturnType<typeof db.select>);
  }
}

const AGENT_ID: string = "11111111-1111-1111-1111-111111111111";
const CRED_ID: string = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const sampleAgentRow: AgentRowDb = {
  id: AGENT_ID,
  name: "sample agent",
  modelProvider: "openai",
  model: "gpt-4o",
  prompt: "you are helpful",
  temperature: "0.7",
  maxTokens: 2048,
  maxSteps: 5,
  toolChoice: "auto",
  credentialId: CRED_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AgentPool: cache semantics ────────────────────────────────────────────────

describe("AgentPool: cache semantics", () => {
  it("returns the spec on hit and only invokes the loader once", async () => {
    const loader: AgentSpecLoader = vi.fn(async (id: string) => fakeSpec(id));
    const pool = new AgentPool({ load: loader });

    const a = await pool.get(AGENT_ID);
    const b = await pool.get(AGENT_ID);

    expect(a).not.toBeNull();
    expect(a).toBe(b); // identity reuse — same cached object
    expect(loader).toHaveBeenCalledTimes(1);
    expect(pool._size()).toBe(1);
  });

  it("returns null when the loader resolves to null and does not cache the miss", async () => {
    const loader: AgentSpecLoader = vi.fn(async () => null);
    const pool = new AgentPool({ load: loader });

    expect(await pool.get(AGENT_ID)).toBeNull();
    expect(await pool.get(AGENT_ID)).toBeNull();

    // Both calls re-enter the loader: a transient null (e.g.,
    // disabled-then-re-enabled agent) must be re-checked.
    expect(loader).toHaveBeenCalledTimes(2);
    expect(pool._size()).toBe(0);
  });

  it("dedupes concurrent first-time fetches for the same agentId", async () => {
    let resolveLoader: (s: AgentSpec | null) => void = () => undefined;
    const loader: AgentSpecLoader = vi.fn(
      () =>
        new Promise<AgentSpec | null>((res) => {
          resolveLoader = res;
        }),
    );
    const pool = new AgentPool({ load: loader });

    const promises = [pool.get(AGENT_ID), pool.get(AGENT_ID), pool.get(AGENT_ID)];
    resolveLoader(fakeSpec(AGENT_ID));
    const [a, b, c] = await Promise.all(promises);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

// ── AgentPool: invalidation ───────────────────────────────────────────────────

describe("AgentPool: invalidate / invalidateAll", () => {
  it("drops a single entry on invalidate", async () => {
    const loader: AgentSpecLoader = vi.fn(async (id: string) => fakeSpec(id));
    const pool = new AgentPool({ load: loader });

    await pool.get(AGENT_ID);
    expect(pool._has(AGENT_ID)).toBe(true);

    pool.invalidate(AGENT_ID);
    expect(pool._has(AGENT_ID)).toBe(false);

    await pool.get(AGENT_ID);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("clears every entry on invalidateAll", async () => {
    const loader: AgentSpecLoader = vi.fn(async (id: string) => fakeSpec(id));
    const pool = new AgentPool({ load: loader });

    await pool.get("a");
    await pool.get("b");
    await pool.get("c");
    expect(pool._size()).toBe(3);

    pool.invalidateAll();
    expect(pool._size()).toBe(0);
  });
});

describe("AgentPool: invalidateByCredential", () => {
  it("drops every spec whose builtin_agent.credentialId matches", async () => {
    const loader: AgentSpecLoader = vi.fn(async (id: string) => fakeSpec(id));
    const pool = new AgentPool({ load: loader });

    await pool.get("a-1");
    await pool.get("a-2");
    await pool.get("a-3");
    expect(pool._size()).toBe(3);

    // The reverse lookup returns the two agents bound to CRED_ID.
    mockSelectChain([
      { kind: "where", rows: [{ id: "a-1" }, { id: "a-3" }] },
    ]);

    await pool.invalidateByCredential(CRED_ID);

    expect(pool._has("a-1")).toBe(false);
    expect(pool._has("a-2")).toBe(true);
    expect(pool._has("a-3")).toBe(false);
  });

  it("is a no-op when no agents reference the credential", async () => {
    const loader: AgentSpecLoader = vi.fn(async (id: string) => fakeSpec(id));
    const pool = new AgentPool({ load: loader });

    await pool.get("a-1");
    mockSelectChain([{ kind: "where", rows: [] }]);

    await expect(pool.invalidateByCredential(CRED_ID)).resolves.toBeUndefined();
    expect(pool._has("a-1")).toBe(true);
  });
});

// ── defaultLoadAgentSpec ──────────────────────────────────────────────────────

describe("defaultLoadAgentSpec", () => {
  it("returns null when the agent row is missing or disabled", async () => {
    mockSelectChain([{ kind: "limit", rows: [] }]);

    expect(await defaultLoadAgentSpec(AGENT_ID)).toBeNull();
    // Loader must short-circuit before touching the credential lookup.
    expect(getCredentialConfigById).not.toHaveBeenCalled();
  });

  it("returns null when the credential cannot be decrypted", async () => {
    mockSelectChain([{ kind: "limit", rows: [sampleAgentRow] }]);
    vi.mocked(getCredentialConfigById).mockResolvedValue({
      id: CRED_ID,
      token: null,
      restUrl: null,
      aguiUrl: null,
      provider: "openai",
    });

    expect(await defaultLoadAgentSpec(AGENT_ID)).toBeNull();
  });

  it("hydrates a full spec including the decrypted apiKey", async () => {
    mockSelectChain([
      { kind: "limit", rows: [sampleAgentRow] },
      { kind: "orderBy", rows: [] },
    ]);
    vi.mocked(getCredentialConfigById).mockResolvedValue({
      id: CRED_ID,
      token: "sk-decrypted",
      restUrl: null,
      aguiUrl: null,
      provider: "openai",
    });

    const spec = await defaultLoadAgentSpec(AGENT_ID);

    expect(spec).toEqual({
      agentId: AGENT_ID,
      name: "sample agent",
      modelProvider: "openai",
      model: "gpt-4o",
      prompt: "you are helpful",
      temperature: 0.7, // parsed to number
      maxTokens: 2048,
      toolChoice: "auto",
      maxSteps: 5,
      apiKey: "sk-decrypted",
      restUrl: null,
      tools: [],
    });
  });

  it("preserves order from the orderBy clause and maps every tool variant", async () => {
    mockSelectChain([
      { kind: "limit", rows: [sampleAgentRow] },
      {
        kind: "orderBy",
        rows: [
          row("mcp_server", { mcpServerId: "mcp-1" }),
          row("mcp_tool", { mcpServerId: "mcp-1", mcpToolName: "search" }),
          row("skill", { skillId: "skill-1" }),
          row("builtin_tool", { builtinTool: "web_search" }),
        ],
      },
    ]);
    vi.mocked(getCredentialConfigById).mockResolvedValue({
      id: CRED_ID,
      token: "sk-x",
      restUrl: null,
      aguiUrl: null,
      provider: "openai",
    });

    const spec = await defaultLoadAgentSpec(AGENT_ID);

    expect(spec?.tools).toEqual([
      { kind: "mcp_server", mcpServerId: "mcp-1" },
      { kind: "mcp_tool", mcpServerId: "mcp-1", toolName: "search" },
      { kind: "skill", skillId: "skill-1" },
      { kind: "builtin_tool", name: "web_search" },
    ]);
  });

  it("silently drops dangling tool rows whose required FK is null", async () => {
    // Every variant includes one row with a null required column. These
    // are dangling bindings (upstream tool deleted with ON DELETE SET
    // NULL); the loader must skip them so the runtime never tries to
    // invoke a non-existent tool.
    mockSelectChain([
      { kind: "limit", rows: [sampleAgentRow] },
      {
        kind: "orderBy",
        rows: [
          row("mcp_server", { mcpServerId: null }),
          row("mcp_server", { mcpServerId: "mcp-ok" }),
          row("mcp_tool", { mcpServerId: "mcp-1", mcpToolName: null }),
          row("skill", { skillId: null }),
          row("builtin_tool", { builtinTool: null }),
        ],
      },
    ]);
    vi.mocked(getCredentialConfigById).mockResolvedValue({
      id: CRED_ID,
      token: "sk-x",
      restUrl: null,
      aguiUrl: null,
      provider: "openai",
    });

    const spec = await defaultLoadAgentSpec(AGENT_ID);

    expect(spec?.tools).toEqual([{ kind: "mcp_server", mcpServerId: "mcp-ok" }]);
  });

  it("treats a null temperature as 'use provider default' (returns null on the spec)", async () => {
    mockSelectChain([
      {
        kind: "limit",
        rows: [{ ...sampleAgentRow, temperature: null }],
      },
      { kind: "orderBy", rows: [] },
    ]);
    vi.mocked(getCredentialConfigById).mockResolvedValue({
      id: CRED_ID,
      token: "sk-x",
      restUrl: null,
      aguiUrl: null,
      provider: "openai",
    });

    const spec = await defaultLoadAgentSpec(AGENT_ID);

    expect(spec?.temperature).toBeNull();
  });
});

// ── Test fixtures ─────────────────────────────────────────────────────────────

function fakeSpec(agentId: string): AgentSpec {
  return {
    agentId,
    name: `agent-${agentId}`,
    isSupervisor: false,
    role: null,
    modelProvider: "openai",
    model: "gpt-4o",
    prompt: null,
    temperature: null,
    maxTokens: null,
    toolChoice: "auto",
    maxSteps: 5,
    apiKey: "sk-fake",
    restUrl: null,
    tools: [],
  };
}

/** Build a junction-table row with sensible nulls everywhere except overrides. */
function row(toolType: string, overrides: Partial<ToolRowDb>): ToolRowDb {
  return {
    toolType,
    mcpServerId: null,
    mcpToolName: null,
    skillId: null,
    builtinTool: null,
    ...overrides,
  };
}
