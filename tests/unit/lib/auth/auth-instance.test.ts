/**
 * Unit tests for src/lib/auth/auth-instance.ts.
 *
 * The module instantiates better-auth at import time and exposes
 * `auth`, `getIsFirstUser`, and `getSession`. The internal `options`
 * object (plugins, session, databaseHooks, hooks) is captured by
 * mocking the `betterAuth` factory so we can assert configuration and
 * invoke the hook callbacks directly.
 *
 * `requireSession` / `requireAdmin` / `requireEditor` live in a sibling
 * file (route-guards.ts) and are intentionally NOT tested here.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";

// Stable mock references that survive vi.resetModules() — mock factories
// re-execute on re-import but always return the same vi.fn instances.
const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  dbUpdate: vi.fn(),
  betterAuth: vi.fn(),
  drizzleAdapter: vi.fn(),
  nextCookies: vi.fn(),
  adminPlugin: vi.fn(),
  createAuthMiddleware: vi.fn(),
  headers: vi.fn(),
  getSessionApi: vi.fn(),
  seedArtifact: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  capturedOptions: { value: null as any },
  capturedHookFn: { value: null as unknown as (ctx: Record<string, unknown>) => Promise<void> },
}));


vi.mock("better-auth", () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: mocks.drizzleAdapter,
}));

vi.mock("better-auth/next-js", () => ({
  nextCookies: mocks.nextCookies,
}));

vi.mock("better-auth/plugins", () => ({
  admin: mocks.adminPlugin,
}));

vi.mock("better-auth/api", () => ({
  createAuthMiddleware: mocks.createAuthMiddleware,
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mocks.dbSelect,
    insert: mocks.dbInsert,
    update: mocks.dbUpdate,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  // Placeholder column symbols — only used as opaque args to the mocked
  // db chain and to drizzle-orm builders (count/eq/isNull), which we do
  // not assert on.
  UserTable: { id: "user.id", deletedAt: "user.deletedAt" },
  SessionTable: { id: "session.id" },
  AccountTable: { id: "account.id" },
  VerificationTable: { id: "verification.id" },
  LoginEventTable: { id: "login-event.id" },
}));

vi.mock("@/lib/artifacts/service", () => ({
  seedArtifactCategoriesForUser: mocks.seedArtifact,
}));

// drizzle-orm (count/eq/isNull) intentionally NOT mocked — they are pure
// query builders; their return values flow into the mocked db chain which
// ignores them.

let mod: typeof import("@/lib/auth/auth-instance");

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.betterAuth.mockImplementation((opts: Record<string, unknown>) => {
    mocks.capturedOptions.value = opts;
    return { api: { getSession: mocks.getSessionApi } };
  });
  mocks.createAuthMiddleware.mockImplementation(
    (fn: (ctx: Record<string, unknown>) => Promise<void>) => {
      mocks.capturedHookFn.value = fn;
      return "auth-middleware-stub";
    },
  );
  vi.resetModules();
  mod = await import("@/lib/auth/auth-instance");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Chained drizzle builder helpers ─────────────────────────────────

/** db.select(...).from(...).where(...) → resolves to `rows` (no limit). */
function mockSelectWhere(rows: unknown[]): void {
  mocks.dbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });
}

/** db.select(...).from(...).where(...).limit(1) → resolves to `rows`. */
function mockSelectWhereLimit(rows: unknown[]): void {
  mocks.dbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

/** db.insert(...).values(...).execute() → resolves; returns values mock. */
function mockInsertChain(): Mock {
  const valuesMock = vi.fn();
  valuesMock.mockReturnValue({ execute: vi.fn().mockResolvedValue(undefined) });
  mocks.dbInsert.mockReturnValue({ values: valuesMock });
  return valuesMock;
}

/** db.update(...).set(...).where(...) → resolves; returns {set, where} mocks. */
function mockUpdateChain(): { setMock: Mock; whereMock: Mock } {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  mocks.dbUpdate.mockReturnValue({ set: setMock });
  return { setMock, whereMock };
}

// ── AuthInstanceTest ────────────────────────────────────────────────

describe("AuthInstanceTest", () => {
  // ── auth export ──────────────────────────────────────────────────

  describe("auth export", () => {
    it("is the betterAuth() return value exposing api.getSession", () => {
      expect(mod.auth).toEqual({ api: { getSession: mocks.getSessionApi } });
      expect(mocks.betterAuth).toHaveBeenCalledTimes(1);
    });
  });

  // ── options: betterAuth factory configuration ─────────────────────

  describe("options: betterAuth factory configuration", () => {
    it("enables emailAndPassword", () => {
      expect(mocks.capturedOptions.value.emailAndPassword).toEqual({ enabled: true });
    });

    it("configures session cookie cache, expiry, and updateAge", () => {
      expect(mocks.capturedOptions.value.session).toEqual({
        cookieCache: { enabled: true, maxAge: 60 * 60 },
        expiresIn: 60 * 60 * 24 * 5,
        updateAge: 60 * 60 * 24,
      });
    });

    it("disables advanced.database.generateId", () => {
      const advanced = mocks.capturedOptions.value.advanced as Record<string, unknown>;
      const database = advanced.database as Record<string, unknown>;
      expect(database.generateId).toBe(false);
    });

    it("invokes adminPlugin with defaultRole user and adminRoles [admin]", () => {
      expect(mocks.adminPlugin).toHaveBeenCalledTimes(1);
      expect(mocks.adminPlugin).toHaveBeenCalledWith({
        defaultRole: "user",
        adminRoles: ["admin"],
      });
    });

    it("invokes nextCookies once", () => {
      expect(mocks.nextCookies).toHaveBeenCalledTimes(1);
    });

    it("invokes drizzleAdapter with db, pg provider, and schema tables", () => {
      expect(mocks.drizzleAdapter).toHaveBeenCalledTimes(1);
      const [dbArg, configArg] = mocks.drizzleAdapter.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(dbArg).toEqual({
        select: mocks.dbSelect,
        insert: mocks.dbInsert,
        update: mocks.dbUpdate,
      });
      expect(configArg.provider).toBe("pg");
      const schema = configArg.schema as Record<string, unknown>;
      expect(schema.user).toEqual({ id: "user.id", deletedAt: "user.deletedAt" });
      expect(schema.session).toEqual({ id: "session.id" });
      expect(schema.account).toEqual({ id: "account.id" });
      expect(schema.verification).toEqual({ id: "verification.id" });
    });

    it("exposes additional user fields with correct input flags", () => {
      const user = mocks.capturedOptions.value.user as Record<string, unknown>;
      const af = user.additionalFields as Record<string, unknown>;
      // input: true (client-writable)
      expect(af.org).toEqual({ type: "string", required: false, input: true });
      expect(af.timezone).toEqual({ type: "string", required: false, input: true });
      expect(af.imAccounts).toEqual({ type: "string", required: false, input: true });
      expect(af.ttsVoice).toEqual({ type: "string", required: false, input: true });
      // input: false (server-managed only)
      expect(af.mustChangePassword).toEqual({
        type: "boolean",
        required: false,
        input: false,
      });
    });

    it.each([
      { name: "returns false when NO_HTTPS=1", env: { NO_HTTPS: "1" }, expected: false },
      { name: "returns true in production", env: { NODE_ENV: "production", NO_HTTPS: "" }, expected: true },
      { name: "returns false in non-production", env: { NODE_ENV: "test", NO_HTTPS: "" }, expected: false },
    ])("useSecureCookies $name", async ({ env, expected }) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      vi.resetModules();
      await import("@/lib/auth/auth-instance");
      const advanced = mocks.capturedOptions.value.advanced as Record<string, unknown>;
      expect(advanced.useSecureCookies).toBe(expected);
    });
  });

  // ── getIsFirstUser ───────────────────────────────────────────────

  describe("getIsFirstUser", () => {
    it("returns true when no active users exist (count=0)", async () => {
      mockSelectWhere([{ c: 0 }]);
      await expect(mod.getIsFirstUser()).resolves.toBe(true);
      expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
    });

    it("returns false when active users exist and caches false for subsequent calls", async () => {
      mockSelectWhere([{ c: 3 }]);
      await expect(mod.getIsFirstUser()).resolves.toBe(false);
      expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
      // Second call short-circuits via cache without hitting the DB.
      await expect(mod.getIsFirstUser()).resolves.toBe(false);
      expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
    });

    it("returns false and caches false when the DB query throws", async () => {
      mocks.dbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error("db down")),
        }),
      });
      await expect(mod.getIsFirstUser()).resolves.toBe(false);
      expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
      // Cached false → second call does not hit DB.
      await expect(mod.getIsFirstUser()).resolves.toBe(false);
      expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
    });
  });

  // ── getSession ───────────────────────────────────────────────────

  describe("getSession", () => {
    beforeEach(() => {
      mocks.headers.mockResolvedValue(new Headers());
    });

    it("returns null when auth.api.getSession resolves null (no db lookup)", async () => {
      mocks.getSessionApi.mockResolvedValue(null);
      await expect(mod.getSession()).resolves.toBe(null);
      expect(mocks.getSessionApi).toHaveBeenCalledTimes(1);
      expect(mocks.dbSelect).not.toHaveBeenCalled();
    });

    it("returns the session when the user is active (deletedAt null)", async () => {
      const session = { user: { id: "u1" }, session: { id: "s1" } };
      mocks.getSessionApi.mockResolvedValue(session);
      mockSelectWhereLimit([{ deletedAt: null }]);
      await expect(mod.getSession()).resolves.toBe(session);
    });

    it("returns null when the user is soft-deleted (deletedAt set)", async () => {
      mocks.getSessionApi.mockResolvedValue({ user: { id: "u1" } });
      mockSelectWhereLimit([{ deletedAt: new Date("2024-01-01T00:00:00Z") }]);
      await expect(mod.getSession()).resolves.toBe(null);
    });

    it("returns null when the user row is missing", async () => {
      mocks.getSessionApi.mockResolvedValue({ user: { id: "ghost" } });
      mockSelectWhereLimit([]);
      await expect(mod.getSession()).resolves.toBe(null);
    });

    it("returns null when auth.api.getSession throws", async () => {
      mocks.getSessionApi.mockRejectedValue(new Error("session lookup failed"));
      await expect(mod.getSession()).resolves.toBe(null);
    });

    it("returns null when headers() throws", async () => {
      mocks.headers.mockRejectedValue(new Error("no headers"));
      await expect(mod.getSession()).resolves.toBe(null);
    });
  });

  // ── databaseHooks.user.create.before ─────────────────────────────

  describe("databaseHooks.user.create.before", () => {
    let beforeHook: (user: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;

    beforeEach(() => {
      beforeHook = mocks.capturedOptions.value.databaseHooks.user.create
        .before as typeof beforeHook;
    });

    it("assigns admin role for the first user (count=0)", async () => {
      mockSelectWhere([{ c: 0 }]);
      const result = await beforeHook({ id: "u1", email: "a@b.c" });
      expect(result).toEqual({ data: { id: "u1", email: "a@b.c", role: "admin" } });
    });

    it("assigns default user role for a subsequent user without role", async () => {
      mockSelectWhere([{ c: 1 }]);
      const result = await beforeHook({ id: "u2" });
      expect(result).toEqual({ data: { id: "u2", role: "user" } });
    });

    it("preserves a valid provided role (editor) for a subsequent user", async () => {
      mockSelectWhere([{ c: 1 }]);
      const result = await beforeHook({ id: "u3", role: "editor" });
      expect(result).toEqual({ data: { id: "u3", role: "editor" } });
    });

    it("falls back to user role when the provided role is invalid", async () => {
      mockSelectWhere([{ c: 1 }]);
      const result = await beforeHook({ id: "u4", role: "superadmin" });
      expect(result).toEqual({ data: { id: "u4", role: "user" } });
    });
  });

  // ── databaseHooks.user.create.after ──────────────────────────────

  describe("databaseHooks.user.create.after", () => {
    let afterHook: (user: Record<string, unknown>) => Promise<void>;

    beforeEach(() => {
      afterHook = mocks.capturedOptions.value.databaseHooks.user.create
        .after as typeof afterHook;
    });

    it("seeds artifact categories when user.id is a string", async () => {
      mocks.seedArtifact.mockResolvedValue(undefined);
      await afterHook({ id: "u1" });
      expect(mocks.seedArtifact).toHaveBeenCalledTimes(1);
      expect(mocks.seedArtifact).toHaveBeenCalledWith("u1");
    });


    it("swallows seed errors without throwing", async () => {
      mocks.seedArtifact.mockRejectedValue(new Error("seed failed"));
      await expect(afterHook({ id: "u2" })).resolves.toBeUndefined();
      expect(mocks.seedArtifact).toHaveBeenCalledTimes(1);
    });
  });

  // ── databaseHooks.session hooks (recordLoginEvent) ────────────────

  describe("databaseHooks.session hooks", () => {
    it("session.create.after records a sign_in event with ip and user-agent", async () => {
      const valuesMock = mockInsertChain();
      const after = mocks.capturedOptions.value.databaseHooks.session.create.after as (
        session: Record<string, unknown>,
        ctx: Record<string, unknown> | null,
      ) => Promise<void>;

      const headers = new Headers();
      headers.set("x-forwarded-for", "1.2.3.4");
      headers.set("user-agent", "Mozilla/5.0");
      await after({ userId: "u1" }, { request: { headers } });

      expect(valuesMock).toHaveBeenCalledWith({
        userId: "u1",
        eventType: "sign_in",
        ipAddress: "1.2.3.4",
        userAgent: "Mozilla/5.0",
        detail: undefined,
      });
    });

    it("session.create.after falls back to x-real-ip when x-forwarded-for absent", async () => {
      const valuesMock = mockInsertChain();
      const after = mocks.capturedOptions.value.databaseHooks.session.create.after as (
        session: Record<string, unknown>,
        ctx: Record<string, unknown> | null,
      ) => Promise<void>;

      const headers = new Headers();
      headers.set("x-real-ip", "5.6.7.8");
      await after({ userId: "u1" }, { request: { headers } });

      expect(valuesMock).toHaveBeenCalledWith({
        userId: "u1",
        eventType: "sign_in",
        ipAddress: "5.6.7.8",
        userAgent: null,
        detail: undefined,
      });
    });

    it("session.create.after handles null ctx (ip/ua null)", async () => {
      const valuesMock = mockInsertChain();
      const after = mocks.capturedOptions.value.databaseHooks.session.create.after as (
        session: Record<string, unknown>,
        ctx: Record<string, unknown> | null,
      ) => Promise<void>;

      await after({ userId: "u1" }, null);

      expect(valuesMock).toHaveBeenCalledWith({
        userId: "u1",
        eventType: "sign_in",
        ipAddress: null,
        userAgent: null,
        detail: undefined,
      });
    });

    it("session.create.after coerces non-string userId to null", async () => {
      const valuesMock = mockInsertChain();
      const after = mocks.capturedOptions.value.databaseHooks.session.create.after as (
        session: Record<string, unknown>,
        ctx: Record<string, unknown> | null,
      ) => Promise<void>;

      await after({ userId: 123 }, null);

      expect(valuesMock).toHaveBeenCalledWith({
        userId: null,
        eventType: "sign_in",
        ipAddress: null,
        userAgent: null,
        detail: undefined,
      });
    });

    it("session.delete.before records a sign_out event", async () => {
      const valuesMock = mockInsertChain();
      const before = mocks.capturedOptions.value.databaseHooks.session.delete.before as (
        session: Record<string, unknown>,
        ctx: Record<string, unknown> | null,
      ) => Promise<void>;

      const headers = new Headers();
      headers.set("x-forwarded-for", "9.9.9.9");
      headers.set("user-agent", "curl/8");
      await before({ userId: "u2" }, { request: { headers } });

      expect(valuesMock).toHaveBeenCalledWith({
        userId: "u2",
        eventType: "sign_out",
        ipAddress: "9.9.9.9",
        userAgent: "curl/8",
        detail: undefined,
      });
    });

    it("session.delete.before coerces non-string userId to null", async () => {
      const valuesMock = mockInsertChain();
      const before = mocks.capturedOptions.value.databaseHooks.session.delete.before as (
        session: Record<string, unknown>,
        ctx: Record<string, unknown> | null,
      ) => Promise<void>;

      await before({ userId: 999 }, null);

      expect(valuesMock).toHaveBeenCalledWith({
        userId: null,
        eventType: "sign_out",
        ipAddress: null,
        userAgent: null,
        detail: undefined,
      });
    });

    it("logs a warning when the login event insert fails (fire-and-forget catch)", async () => {
      // execute() rejects → recordLoginEvent's .catch() must log and swallow.
      const valuesMock = vi.fn();
      valuesMock.mockReturnValue({
        execute: vi.fn().mockRejectedValue(new Error("insert failed")),
      });
      mocks.dbInsert.mockReturnValue({ values: valuesMock });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const after = mocks.capturedOptions.value.databaseHooks.session.create.after as (
        session: Record<string, unknown>,
        ctx: Record<string, unknown> | null,
      ) => Promise<void>;
      await after({ userId: "u1" }, null);
      // recordLoginEvent is fire-and-forget; flush the microtask queue so
      // the rejected promise's .catch() callback runs.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(warnSpy).toHaveBeenCalledWith(
        "[auth] login event write failed:",
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });

  // ── hooks.after (change-password) ────────────────────────────────

  describe("hooks.after (change-password)", () => {
    it("resets mustChangePassword when path includes change-password and session user id is present", async () => {
      const { setMock, whereMock } = mockUpdateChain();
      await mocks.capturedHookFn.value({
        path: "/api/auth/change-password",
        session: { user: { id: "u1" } },
      });
      expect(mocks.dbUpdate).toHaveBeenCalledTimes(1);
      expect(setMock).toHaveBeenCalledWith({ mustChangePassword: false });
      expect(whereMock).toHaveBeenCalledTimes(1);
    });

    it("extracts userId from context.session.user.id fallback", async () => {
      const { whereMock } = mockUpdateChain();
      await mocks.capturedHookFn.value({
        path: "/change-password",
        context: { session: { user: { id: "u2" } } },
      });
      expect(whereMock).toHaveBeenCalledTimes(1);
    });

    it("extracts userId from context.user.id fallback", async () => {
      const { whereMock } = mockUpdateChain();
      await mocks.capturedHookFn.value({
        path: "/change-password",
        context: { user: { id: "u3" } },
      });
      expect(whereMock).toHaveBeenCalledTimes(1);
    });

    it("does not update when userId is missing", async () => {
      mocks.dbUpdate.mockReturnValue({ set: vi.fn() });
      await mocks.capturedHookFn.value({ path: "/change-password" });
      expect(mocks.dbUpdate).not.toHaveBeenCalled();
    });

    it("does not update when path does not include change-password", async () => {
      mocks.dbUpdate.mockReturnValue({ set: vi.fn() });
      await mocks.capturedHookFn.value({
        path: "/sign-in",
        session: { user: { id: "u1" } },
      });
      expect(mocks.dbUpdate).not.toHaveBeenCalled();
    });
  });
});