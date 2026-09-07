import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {},
}));

import { buildTesterTools } from "@/lib/testing/tester-tools.server";

describe("buildTesterTools — mounting gate (F9-A)", () => {
  it("mounts nothing for a non-editor, non-admin context (fail-closed)", () => {
    const tools = buildTesterTools({ userId: "user-1", isAdmin: false, isEditor: false });
    expect(tools).toEqual([]);
  });

  it("mounts nothing when the context lacks any role flags", () => {
    const tools = buildTesterTools({ userId: "user-1" });
    expect(tools).toEqual([]);
  });

  it("mounts the full toolkit (12 tools, no delete) for an editor", () => {
    const tools = buildTesterTools({ userId: "user-1", isAdmin: false, isEditor: true });
    const names = tools.map((t) => t.name);

    expect(names).toHaveLength(12);
    expect(names).not.toContain("delete_test_case");
    expect(names).toContain("run_test_suite");
    expect(names).toContain("update_test_case");
  });

  it("mounts the full toolkit for an admin", () => {
    const tools = buildTesterTools({ userId: "admin-1", isAdmin: true, isEditor: true });
    expect(tools.map((t) => t.name)).toHaveLength(12);
  });
});
