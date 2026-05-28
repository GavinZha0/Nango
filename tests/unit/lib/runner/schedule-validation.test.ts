import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/runner", () => ({ runner: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => "",
  getConfigNumber: () => 0,
  getConfigMs: () => 0,
}));

import { validateScheduleTarget } from "@/lib/runner/schedule-validation";
import { validateTriggerSpec, isValidTimezone } from "@/lib/runner/scheduler";
import type { EntityDescriptor, EntityKind } from "@/lib/backends/types";

function makeEntity(
  id: string,
  kind: EntityKind,
  credentialId: string,
): EntityDescriptor {
  return {
    id,
    kind,
    provider: "agno",
    credentialId,
  };
}

describe("validateScheduleTarget", () => {
  describe("backend entity", () => {
    const credentialId = "11111111-1111-1111-1111-111111111111";
    const builtinAgentId = "any";

    it("rejects when credential is missing or disabled", async () => {
      const result = await validateScheduleTarget({
        userId: "user-1",
        entityId: "agent-x",
        entityKind: "agent",
        credentialId,
        deps: {
          getEnabledCredential: async () => null,
          listCatalog: async () => [],
          isBuiltinVisibleTo: async () => true,
        },
      });
      expect(result).toEqual({
        ok: false,
        status: 404,
        error: "Backend credential not found or disabled.",
      });
    });

    it("rejects when entityId is not in the credential's catalog", async () => {
      const result = await validateScheduleTarget({
        userId: "user-1",
        entityId: "ghost",
        entityKind: "agent",
        credentialId,
        deps: {
          getEnabledCredential: async () => ({ enabled: true }),
          listCatalog: async () => [makeEntity("real-agent", "agent", credentialId)],
          isBuiltinVisibleTo: async () => true,
        },
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error:
          "Entity 'ghost' is not present in the catalog of credential " +
          `${credentialId}.`,
      });
    });

    it("rejects when entityKind does not match the catalog entry", async () => {
      const result = await validateScheduleTarget({
        userId: "user-1",
        entityId: "real-agent",
        entityKind: "team",
        credentialId,
        deps: {
          getEnabledCredential: async () => ({ enabled: true }),
          listCatalog: async () => [makeEntity("real-agent", "agent", credentialId)],
          isBuiltinVisibleTo: async () => true,
        },
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error:
          "Entity 'real-agent' has kind 'agent' in the catalog; " +
          "scheduled entityKind 'team' does not match.",
      });
    });

    it("accepts when (credentialId, entityId, entityKind) matches catalog", async () => {
      const result = await validateScheduleTarget({
        userId: "user-1",
        entityId: "real-agent",
        entityKind: "agent",
        credentialId,
        deps: {
          getEnabledCredential: async () => ({ enabled: true }),
          listCatalog: async () => [makeEntity("real-agent", "agent", credentialId)],
          isBuiltinVisibleTo: async () => true,
        },
      });
      expect(result).toEqual({ ok: true });
    });

    it("accepts a team entity when kind matches", async () => {
      const result = await validateScheduleTarget({
        userId: "user-1",
        entityId: "research-team",
        entityKind: "team",
        credentialId,
        deps: {
          getEnabledCredential: async () => ({ enabled: true }),
          listCatalog: async () => [
            makeEntity("research-team", "team", credentialId),
            makeEntity("real-agent", "agent", credentialId),
          ],
          isBuiltinVisibleTo: async () => true,
        },
      });
      expect(result).toEqual({ ok: true });
    });

    it("does not call the built-in visibility hook for backend dispatch", async () => {
      let visibilityCalled = false;
      await validateScheduleTarget({
        userId: "user-1",
        entityId: "real-agent",
        entityKind: "agent",
        credentialId,
        deps: {
          getEnabledCredential: async () => ({ enabled: true }),
          listCatalog: async () => [makeEntity("real-agent", "agent", credentialId)],
          isBuiltinVisibleTo: async () => {
            visibilityCalled = true;
            return true;
          },
        },
      });
      expect(visibilityCalled).toBe(false);
      // unused locals (lint hygiene)
      void builtinAgentId;
    });
  });

  describe("built-in entity (no credentialId)", () => {
    it("rejects when entityKind !== 'agent'", async () => {
      const result = await validateScheduleTarget({
        userId: "user-1",
        entityId: "22222222-2222-2222-2222-222222222222",
        entityKind: "team",
        credentialId: undefined,
        deps: {
          getEnabledCredential: async () => null,
          listCatalog: async () => [],
          isBuiltinVisibleTo: async () => true,
        },
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "Built-in entities must have entityKind = 'agent'.",
      });
    });

    it("rejects when the agent is not visible to the user", async () => {
      const result = await validateScheduleTarget({
        userId: "user-1",
        entityId: "22222222-2222-2222-2222-222222222222",
        entityKind: "agent",
        credentialId: undefined,
        deps: {
          getEnabledCredential: async () => null,
          listCatalog: async () => [],
          isBuiltinVisibleTo: async () => false,
        },
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        error: "Built-in agent is not visible.",
      });
    });

    it("accepts when entityKind = 'agent' and visibility passes", async () => {
      const result = await validateScheduleTarget({
        userId: "user-1",
        entityId: "22222222-2222-2222-2222-222222222222",
        entityKind: "agent",
        credentialId: undefined,
        deps: {
          getEnabledCredential: async () => null,
          listCatalog: async () => [],
          isBuiltinVisibleTo: async () => true,
        },
      });
      expect(result).toEqual({ ok: true });
    });

    it("does not call the catalog hook for built-in dispatch", async () => {
      let catalogCalled = false;
      await validateScheduleTarget({
        userId: "user-1",
        entityId: "22222222-2222-2222-2222-222222222222",
        entityKind: "agent",
        credentialId: undefined,
        deps: {
          getEnabledCredential: async () => null,
          listCatalog: async () => {
            catalogCalled = true;
            return [];
          },
          isBuiltinVisibleTo: async () => true,
        },
      });
      expect(catalogCalled).toBe(false);
    });
  });
});

// ── isValidTimezone ──────────────────────────────────────────────────

describe("isValidTimezone", () => {
  it("accepts 'UTC'", () => {
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("accepts a common IANA zone", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
  });

  it("rejects a made-up zone", () => {
    expect(isValidTimezone("America/InvalidCity")).toBe(false);
  });

  it("rejects numeric UTC offsets", () => {
    expect(isValidTimezone("UTC+5")).toBe(false);
    expect(isValidTimezone("+08:00")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidTimezone("")).toBe(false);
  });
});

// ── validateTriggerSpec — timezone ───────────────────────────────────

describe("validateTriggerSpec — timezone", () => {
  const base = {
    startAt: new Date(Date.now() + 60_000),
    endAt: null,
    intervalValue: null,
    intervalUnit: null,
  } as const;

  it("accepts valid timezone", () => {
    const result = validateTriggerSpec({ ...base, timezone: "America/Chicago" });
    expect(result).toEqual({ ok: true });
  });

  it("accepts when timezone is omitted", () => {
    const result = validateTriggerSpec({ ...base });
    expect(result).toEqual({ ok: true });
  });

  it("rejects invalid timezone", () => {
    const result = validateTriggerSpec({ ...base, timezone: "Mars/Olympus" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Mars/Olympus");
    }
  });

  it("rejects numeric offset timezone", () => {
    const result = validateTriggerSpec({ ...base, timezone: "UTC+8" });
    expect(result.ok).toBe(false);
  });
});
