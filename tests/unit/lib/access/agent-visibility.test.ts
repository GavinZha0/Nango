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
    visibility: "visibility",
    createdBy: "created_by",
  },
  UserTable: {
    id: "user_id",
    role: "role",
  },
}));

const { isAgentVisibleTo, listVisibleAgentIds } = await import(
  "@/lib/access/agent-visibility"
);
const { db } = await import("@/lib/db");

interface AgentRow {
  visibility: string;
  createdBy: string;
}

/**
 * Stub the chained drizzle builder
 *   db.select(...).from(...).where(...).limit(1)
 * to resolve with `rows`.
 */
function mockAgentLookup(rows: AgentRow[]): void {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

const AGENT_ID: string = "11111111-1111-1111-1111-111111111111";
const OWNER_ID: string = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STRANGER_ID: string = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("isAgentVisibleTo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when the agent does not exist or is disabled", async () => {
    // Disabled agents are filtered out by the SQL `enabled = true` clause,
    // so the lookup returns an empty result set in both cases — the
    // function cannot (and need not) distinguish them.
    mockAgentLookup([]);
    expect(await isAgentVisibleTo(AGENT_ID, OWNER_ID)).toBe(false);
  });

  it("returns true for a public agent regardless of caller identity", async () => {
    mockAgentLookup([{ visibility: "public", createdBy: OWNER_ID }]);
    expect(await isAgentVisibleTo(AGENT_ID, STRANGER_ID)).toBe(true);
  });

  it("returns true for the owner of a private agent", async () => {
    mockAgentLookup([{ visibility: "private", createdBy: OWNER_ID }]);
    expect(await isAgentVisibleTo(AGENT_ID, OWNER_ID)).toBe(true);
  });

  it("returns false for a non-owner of a private agent", async () => {
    mockAgentLookup([{ visibility: "private", createdBy: OWNER_ID }]);
    expect(await isAgentVisibleTo(AGENT_ID, STRANGER_ID)).toBe(false);
  });

  it("returns true when both visibility=public and caller is owner", async () => {
    // Sanity check: the two predicates are OR-combined; either alone suffices.
    mockAgentLookup([{ visibility: "public", createdBy: OWNER_ID }]);
    expect(await isAgentVisibleTo(AGENT_ID, OWNER_ID)).toBe(true);
  });

  it("treats unknown visibility values conservatively (deny non-owners)", async () => {
    // Defense-in-depth: anything that isn't exactly "public" must NOT
    // grant access to non-owners. This guards against typos / future
    // values like "shared" being silently treated as public.
    mockAgentLookup([{ visibility: "team", createdBy: OWNER_ID }]);
    expect(await isAgentVisibleTo(AGENT_ID, STRANGER_ID)).toBe(false);
    // Owners still get through via the createdBy branch.
    expect(await isAgentVisibleTo(AGENT_ID, OWNER_ID)).toBe(true);
  });
});

/**
 * Stub the chained drizzle builder used by listVisibleAgentIds:
 *   db.select(...).from(...).where(...)
 * (no limit clause — enumeration returns every match).
 */
function mockAgentList(rows: Array<{ id: string }>): void {
  vi.mocked(db.select).mockImplementation((...args: unknown[]) => {
    const projection = args[0] as Record<string, unknown>;

    if ("role" in projection) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: "user" }]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>;
    }

    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    } as unknown as ReturnType<typeof db.select>;
  });
}


describe("listVisibleAgentIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty array when no agents are visible", async () => {
    mockAgentList([]);
    expect(await listVisibleAgentIds(OWNER_ID)).toEqual([]);
  });

  it("projects every row to its id and preserves cardinality", async () => {
    // The SQL filters happen at the DB layer; the function is just a
    // shape transform. We verify the projection, not the predicate
    // (which is exercised by the integration / e2e suite).
    mockAgentList([
      { id: "a1" },
      { id: "a2" },
      { id: "a3" },
    ]);
    expect(await listVisibleAgentIds(OWNER_ID)).toEqual(["a1", "a2", "a3"]);
  });
});
