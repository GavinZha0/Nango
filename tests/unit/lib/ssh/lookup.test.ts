import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Captured DB query state — tests drive it per-case.
const dbState: { rows: unknown[] } = { rows: [] };

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbState.rows,
          orderBy: async () => dbState.rows,
        }),
      }),
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  SshServerTable: { id: "id", name: "name", enabled: "enabled" },
}));

const loadAuthMock = vi.fn();
vi.mock("@/lib/ssh/auth-loader", () => ({
  loadSshAuth: loadAuthMock,
}));

const {
  resolveSshServerByName,
  resolveSshServerById,
  listSshServersByIds,
} = await import("@/lib/ssh/lookup");

beforeEach(() => {
  dbState.rows = [];
  loadAuthMock.mockReset();
});

const enabledRow = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "prod-web-1",
  description: "production web server",
  credentialId: "cred-uuid",
  host: "10.0.1.5",
  port: 22,
  knownHostFingerprint: "SHA256:abcd",
  commandAllow: null,
  commandDeny: [],
  loginShell: true,
  enabled: true,
  visibility: "private",
  createdBy: null,
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("resolveSshServerByName", () => {
  it("returns NOT_FOUND when no row matches", async () => {
    dbState.rows = [];
    const r = await resolveSshServerByName("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("NOT_FOUND");
  });

  it("returns DISABLED when row exists but is disabled", async () => {
    dbState.rows = [{ ...enabledRow, enabled: false }];
    const r = await resolveSshServerByName("prod-web-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("DISABLED");
  });

  it("returns CREDENTIAL_DECRYPT_FAILED when auth blob cannot be loaded", async () => {
    dbState.rows = [enabledRow];
    loadAuthMock.mockResolvedValueOnce(null);
    const r = await resolveSshServerByName("prod-web-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("CREDENTIAL_DECRYPT_FAILED");
  });

  it("returns the resolved server with auth on the happy path", async () => {
    dbState.rows = [enabledRow];
    loadAuthMock.mockResolvedValueOnce({
      kind: "password",
      username: "deploy",
      password: "p",
    });
    const r = await resolveSshServerByName("prod-web-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.host).toBe("10.0.1.5");
      // username comes from the credential, NOT the ssh_server row.
      expect(r.resolved.username).toBe("deploy");
      expect(r.resolved.auth).toEqual({
        kind: "password",
        username: "deploy",
        password: "p",
      });
    }
  });
});

describe("resolveSshServerById", () => {
  it("returns NOT_FOUND for unknown id", async () => {
    dbState.rows = [];
    const r = await resolveSshServerById("missing-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("NOT_FOUND");
  });
});

describe("listSshServersByIds", () => {
  it("returns [] for an empty input list (no DB hit)", async () => {
    const r = await listSshServersByIds([]);
    expect(r).toEqual([]);
  });

  it("strips the `enabled` column from the projection", async () => {
    dbState.rows = [
      {
        id: enabledRow.id,
        name: enabledRow.name,
        description: enabledRow.description,
        host: enabledRow.host,
        port: enabledRow.port,
        enabled: true,
      },
    ];
    const r = await listSshServersByIds([enabledRow.id]);
    expect(r).toHaveLength(1);
    expect(r[0]).not.toHaveProperty("enabled");
    expect(r[0].name).toBe("prod-web-1");
  });
});
