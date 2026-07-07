import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  canViewResource,
  canEditResource,
  canDeleteResource,
  canChangeVisibility,
  isAdmin,
  isEditor,
  isValidRole,
  type ResourceWithRBAC,
} from "@/lib/auth/permissions";
import type { Session } from "@/lib/http/route-handlers";

// Helpers

function session(role: string, userId = "user-1"): Session {
  return { user: { id: userId, role } } as Session;
}

function resource(overrides: Partial<ResourceWithRBAC> = {}): ResourceWithRBAC {
  return {
    source: "local",
    visibility: "private",
    createdBy: "user-1",
    ...overrides,
  };
}

// ── Role utilities ──────────────────────────────────────────────────

describe("isValidRole", () => {
  it.each(["admin", "editor", "user"])("accepts '%s'", (r) => {
    expect(isValidRole(r)).toBe(true);
  });

  it.each(["superadmin", "", null, undefined, 123])("rejects %s", (v) => {
    expect(isValidRole(v)).toBe(false);
  });
});

describe("isAdmin / isEditor", () => {
  it("admin is both admin and editor", () => {
    expect(isAdmin(session("admin"))).toBe(true);
    expect(isEditor(session("admin"))).toBe(true);
  });

  it("editor is editor but not admin", () => {
    expect(isAdmin(session("editor"))).toBe(false);
    expect(isEditor(session("editor"))).toBe(true);
  });

  it("user is neither", () => {
    expect(isAdmin(session("user"))).toBe(false);
    expect(isEditor(session("user"))).toBe(false);
  });
});

// ── canViewResource ─────────────────────────────────────────────────

describe("canViewResource", () => {
  it("admin can view any resource", () => {
    expect(canViewResource(resource({ visibility: "private", createdBy: "other" }), session("admin"))).toBe(true);
  });

  it("public resources are visible to everyone", () => {
    expect(canViewResource(resource({ visibility: "public", createdBy: "other" }), session("user"))).toBe(true);
  });

  it("private resources are visible only to the creator", () => {
    expect(canViewResource(resource({ visibility: "private", createdBy: "user-1" }), session("user", "user-1"))).toBe(true);
    expect(canViewResource(resource({ visibility: "private", createdBy: "other" }), session("user", "user-1"))).toBe(false);
  });
});

// ── canEditResource ─────────────────────────────────────────────────

describe("canEditResource", () => {
  it("builtin resources cannot be edited by any role", () => {
    expect(canEditResource(resource({ source: "builtin" }), session("admin"))).toBe(false);
    expect(canEditResource(resource({ source: "builtin" }), session("editor"))).toBe(false);
  });

  it("plain user cannot edit anything", () => {
    expect(canEditResource(resource({ source: "local" }), session("user"))).toBe(false);
  });

  it("admin can edit any local resource", () => {
    expect(canEditResource(resource({ source: "local", createdBy: "other" }), session("admin"))).toBe(true);
  });

  it("editor can edit own private resource", () => {
    expect(canEditResource(resource({ source: "local", visibility: "private", createdBy: "user-1" }), session("editor", "user-1"))).toBe(true);
  });

  it("editor can edit public resource they don't own", () => {
    expect(canEditResource(resource({ source: "local", visibility: "public", createdBy: "other" }), session("editor", "user-1"))).toBe(false);
  });

  it("editor cannot edit private resource they don't own", () => {
    expect(canEditResource(resource({ source: "local", visibility: "private", createdBy: "other" }), session("editor", "user-1"))).toBe(false);
  });
});

// ── canDeleteResource ───────────────────────────────────────────────

describe("canDeleteResource", () => {
  it("builtin resources cannot be deleted by any role", () => {
    expect(canDeleteResource(resource({ source: "builtin" }), session("admin"))).toBe(false);
  });

  it("admin can delete any local resource", () => {
    expect(canDeleteResource(resource({ source: "local", createdBy: "other" }), session("admin"))).toBe(true);
  });

  it("editor can delete only own resources", () => {
    expect(canDeleteResource(resource({ source: "local", createdBy: "user-1" }), session("editor", "user-1"))).toBe(true);
    expect(canDeleteResource(resource({ source: "local", createdBy: "other" }), session("editor", "user-1"))).toBe(false);
  });

  it("plain user cannot delete anything", () => {
    expect(canDeleteResource(resource({ source: "local", createdBy: "user-1" }), session("user", "user-1"))).toBe(false);
  });
});

// ── canChangeVisibility (alias of canDeleteResource) ────────────────

describe("canChangeVisibility", () => {
  it("follows the same rules as canDeleteResource", () => {
    const r = resource({ source: "local", createdBy: "user-1" });
    const s = session("editor", "user-1");
    expect(canChangeVisibility(r, s)).toBe(canDeleteResource(r, s));
  });

  it("rejects builtin resources", () => {
    expect(canChangeVisibility(resource({ source: "builtin" }), session("admin"))).toBe(false);
  });
});
