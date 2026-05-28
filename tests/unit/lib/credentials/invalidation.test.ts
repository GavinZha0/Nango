import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

vi.mock("@/lib/db/schema", () => ({
  McpServerTable: {
    id: "id",
    credentialId: "credential_id",
  },
  BuiltinAgentToolTable: {
    agentId: "agent_id",
    toolType: "tool_type",
    mcpServerId: "mcp_server_id",
    skillId: "skill_id",
    dataSourceId: "data_source_id",
    sshServerId: "ssh_server_id",
  },
}));

// The two pools are dependency-injected through their singleton modules.
// The cross-cutting helper is a thin orchestrator; we just observe which
// pool methods it calls and with what arguments. Each mock is a fresh vi.fn
// so test order can't bleed.
vi.mock("@/lib/builtin-agents", () => ({
  agentPool: {
    invalidate: vi.fn(),
    invalidateByCredential: vi.fn(),
  },
}));

vi.mock("@/lib/mcp", () => ({
  mcpProviderPool: {
    evict: vi.fn(),
  },
}));

vi.mock("@/lib/skills", () => ({
  skillPool: {
    invalidate: vi.fn(),
  },
}));

vi.mock("@/lib/backends/entity-catalog", () => ({
  EntityCatalog: {
    invalidate: vi.fn(),
  },
}));

const invalidateCredentialCacheMock = vi.fn();
vi.mock("@/lib/credentials/lookup", () => ({
  invalidateCredentialCache: (...args: unknown[]) => invalidateCredentialCacheMock(...args),
}));

const {
  invalidateForCredentialChange,
  invalidateForMcpServerChange,
  invalidateForSkillChange,
  invalidateForDataSourceChange,
  invalidateForSshServerChange,
  invalidateForAgentChange,
} = await import("@/lib/cache/invalidation");
const { db } = await import("@/lib/db");
const { agentPool } = await import("@/lib/builtin-agents");
const { mcpProviderPool } = await import("@/lib/mcp");
const { skillPool } = await import("@/lib/skills");
const { EntityCatalog } = await import("@/lib/backends/entity-catalog");

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Stub the chained drizzle builder
 *   db.select(...).from(...).where(...)
 * to resolve with `rows`. The cross-cutting helpers never call .limit()
 * or .orderBy(), so a single-shape stub is enough.
 */
function mockSelect(rows: unknown[]): void {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

const CRED: string = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MCP: string = "mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentPool.invalidateByCredential).mockResolvedValue(undefined);
  vi.mocked(mcpProviderPool.evict).mockResolvedValue(undefined);
});

// ── invalidateForCredentialChange ─────────────────────────────────────────────

describe("invalidateForCredentialChange", () => {
  it("delegates the agent half to AgentPool.invalidateByCredential", async () => {
    mockSelect([]); // no MCP servers reference the credential
    await invalidateForCredentialChange(CRED);
    expect(agentPool.invalidateByCredential).toHaveBeenCalledExactlyOnceWith(CRED);
  });

  it("calls invalidateCredentialCache to clear the lookup caches and notify subscribers", async () => {
    mockSelect([]);
    await invalidateForCredentialChange(CRED);
    expect(invalidateCredentialCacheMock).toHaveBeenCalledOnce();
  });

  it("calls EntityCatalog.invalidate for the credential", async () => {
    mockSelect([]);
    await invalidateForCredentialChange(CRED);
    expect(EntityCatalog.invalidate).toHaveBeenCalledExactlyOnceWith(CRED);
  });

  it("evicts every MCP server returned by the reverse-index query", async () => {
    mockSelect([{ id: "mcp-1" }, { id: "mcp-2" }]);
    await invalidateForCredentialChange(CRED);

    // Order is unspecified (parallel), so check membership rather than
    // call sequence.
    expect(mcpProviderPool.evict).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(mcpProviderPool.evict).mock.calls.map((c) => c[0]);
    expect(calls.sort()).toEqual(["mcp-1", "mcp-2"]);
  });

  it("is a no-op on the MCP pool when no servers reference the credential", async () => {
    mockSelect([]);
    await invalidateForCredentialChange(CRED);
    expect(mcpProviderPool.evict).not.toHaveBeenCalled();
    // Agent pool is still notified — an agent can use a credential
    // directly (LLM API key) without any MCP wiring.
    expect(agentPool.invalidateByCredential).toHaveBeenCalledOnce();
  });
});

// ── invalidateForMcpServerChange ──────────────────────────────────────────────

describe("invalidateForMcpServerChange", () => {
  it("evicts the provider unconditionally", async () => {
    mockSelect([]); // no agents bind this server
    await invalidateForMcpServerChange(MCP);
    expect(mcpProviderPool.evict).toHaveBeenCalledExactlyOnceWith(MCP);
  });

  it("invalidates every dependent agent spec", async () => {
    mockSelect([
      { agentId: "a-1" },
      { agentId: "a-2" },
    ]);
    await invalidateForMcpServerChange(MCP);
    expect(agentPool.invalidate).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(agentPool.invalidate).mock.calls.map((c) => c[0]);
    expect(calls.sort()).toEqual(["a-1", "a-2"]);
  });

  it("dedupes duplicate agentId rows from the junction table", async () => {
    // An agent can plausibly bind the same MCP server through multiple
    // junction rows (different tool subsets per row). One invalidate
    // call per agent is enough — confirm the helper coalesces.
    mockSelect([
      { agentId: "a-1" },
      { agentId: "a-1" },
      { agentId: "a-2" },
      { agentId: "a-1" },
    ]);
    await invalidateForMcpServerChange(MCP);

    expect(agentPool.invalidate).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(agentPool.invalidate).mock.calls.map((c) => c[0]);
    expect(calls.sort()).toEqual(["a-1", "a-2"]);
  });

  it("still evicts the provider when no agents depend on it", async () => {
    mockSelect([]);
    await invalidateForMcpServerChange(MCP);
    expect(mcpProviderPool.evict).toHaveBeenCalledOnce();
    expect(agentPool.invalidate).not.toHaveBeenCalled();
  });
});

// ── invalidateForDataSourceChange ─────────────────────────────────────────────

const DS: string = "dddddddd-dddd-dddd-dddd-dddddddddddd";

describe("invalidateForDataSourceChange", () => {
  it("invalidates every agent that binds this data source", async () => {
    mockSelect([{ agentId: "a-1" }, { agentId: "a-2" }]);
    await invalidateForDataSourceChange(DS);
    expect(agentPool.invalidate).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(agentPool.invalidate).mock.calls.map((c) => c[0]);
    expect(calls.sort()).toEqual(["a-1", "a-2"]);
  });

  it("dedupes duplicate agentId rows", async () => {
    mockSelect([
      { agentId: "a-1" },
      { agentId: "a-1" },
      { agentId: "a-2" },
    ]);
    await invalidateForDataSourceChange(DS);
    expect(agentPool.invalidate).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when no agents bind the source", async () => {
    mockSelect([]);
    await invalidateForDataSourceChange(DS);
    expect(agentPool.invalidate).not.toHaveBeenCalled();
    // Data sources have no provider pool — only the agent specs matter.
    expect(mcpProviderPool.evict).not.toHaveBeenCalled();
  });
});

// ── invalidateForSkillChange ──────────────────────────────────────────────────

const SKILL: string = "ssssssss-ssss-ssss-ssss-ssssssssssss";

describe("invalidateForSkillChange", () => {
  it("invalidates the skill pool entry", async () => {
    mockSelect([]);
    await invalidateForSkillChange(SKILL);
    expect(skillPool.invalidate).toHaveBeenCalledExactlyOnceWith(SKILL);
  });

  it("invalidates every agent that binds the skill", async () => {
    mockSelect([{ agentId: "a-1" }, { agentId: "a-2" }]);
    await invalidateForSkillChange(SKILL);
    expect(agentPool.invalidate).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(agentPool.invalidate).mock.calls.map((c) => c[0]);
    expect(calls.sort()).toEqual(["a-1", "a-2"]);
  });

  it("dedupes duplicate agentId rows", async () => {
    mockSelect([{ agentId: "a-1" }, { agentId: "a-1" }, { agentId: "a-2" }]);
    await invalidateForSkillChange(SKILL);
    expect(agentPool.invalidate).toHaveBeenCalledTimes(2);
  });

  it("is a no-op on agent pool when no agents bind the skill", async () => {
    mockSelect([]);
    await invalidateForSkillChange(SKILL);
    expect(agentPool.invalidate).not.toHaveBeenCalled();
    // Skill pool is still cleared unconditionally.
    expect(skillPool.invalidate).toHaveBeenCalledOnce();
  });
});

// ── invalidateForSshServerChange ──────────────────────────────────────────────

const SSH: string = "hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh";

describe("invalidateForSshServerChange", () => {
  it("invalidates every agent that binds the SSH server", async () => {
    mockSelect([{ agentId: "a-1" }]);
    await invalidateForSshServerChange(SSH);
    expect(agentPool.invalidate).toHaveBeenCalledExactlyOnceWith("a-1");
  });

  it("is a no-op when no agents bind the server", async () => {
    mockSelect([]);
    await invalidateForSshServerChange(SSH);
    expect(agentPool.invalidate).not.toHaveBeenCalled();
  });
});

// ── invalidateForAgentChange ──────────────────────────────────────────────────

describe("invalidateForAgentChange", () => {
  it("invalidates the agent pool entry directly", () => {
    invalidateForAgentChange("a-42");
    expect(agentPool.invalidate).toHaveBeenCalledExactlyOnceWith("a-42");
  });
});
