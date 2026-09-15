import { describe, it, expect } from "vitest";
import { mcpGroupSchema } from "@/lib/http/validation";
import {
  parseCollapsedGroups,
  serializeCollapsedGroups,
  groupMcpServers,
  findExistingGroupMatch,
  SSR_EMPTY_SET,
} from "@/components/left-panels/McpPanel";

describe("McpPanel - parseCollapsedGroups & serializeCollapsedGroups", () => {
  it("returns SSR_EMPTY_SET for null or empty input", () => {
    expect(parseCollapsedGroups(null)).toBe(SSR_EMPTY_SET);
    expect(parseCollapsedGroups("")).toBe(SSR_EMPTY_SET);
  });

  it("parses array format correctly", () => {
    const raw = JSON.stringify(["Database", "Testing"]);
    const set = parseCollapsedGroups(raw);
    expect(set.has("Database")).toBe(true);
    expect(set.has("Testing")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("parses legacy object format correctly", () => {
    const raw = JSON.stringify({ Database: true, Testing: false, Search: true });
    const set = parseCollapsedGroups(raw);
    expect(set.has("Database")).toBe(true);
    expect(set.has("Testing")).toBe(false);
    expect(set.has("Search")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("handles malformed JSON gracefully", () => {
    expect(parseCollapsedGroups("{invalid-json")).toBe(SSR_EMPTY_SET);
  });

  it("serializes Set to JSON array string", () => {
    const set = new Set(["GroupA", "GroupB"]);
    const serialized = serializeCollapsedGroups(set);
    expect(JSON.parse(serialized)).toEqual(["GroupA", "GroupB"]);
  });
});

describe("McpPanel - groupMcpServers", () => {
  it("returns null grouped when all servers are ungrouped", () => {
    const servers = [
      { name: "Server B", group: null },
      { name: "Server A", group: "" },
      { name: "Server C", group: undefined },
    ];
    const res = groupMcpServers(servers);
    expect(res.existingGroups).toEqual([]);
    expect(res.grouped).toBeNull();
  });

  it("groups servers by group name in alphabetical order", () => {
    const servers = [
      { name: "Server Alpha", group: "Testing" },
      { name: "Server Beta", group: "Database" },
      { name: "Server Gamma", group: "Database" },
    ];
    const res = groupMcpServers(servers);
    expect(res.existingGroups).toEqual(["Database", "Testing"]);
    expect(res.grouped).toHaveLength(2);
    expect(res.grouped![0].name).toBe("Database");
    expect(res.grouped![0].servers.map((s) => s.name)).toEqual(["Server Beta", "Server Gamma"]);
    expect(res.grouped![1].name).toBe("Testing");
    expect(res.grouped![1].servers.map((s) => s.name)).toEqual(["Server Alpha"]);
  });

  it("appends Ungrouped group when some servers have groups and others do not", () => {
    const servers = [
      { name: "Z-Ungrouped", group: null },
      { name: "Server A", group: "Group 1" },
      { name: "A-Ungrouped", group: "" },
    ];
    const res = groupMcpServers(servers);
    expect(res.existingGroups).toEqual(["Group 1"]);
    expect(res.grouped).toHaveLength(2);
    expect(res.grouped![0].name).toBe("Group 1");
    expect(res.grouped![1].name).toBe("Ungrouped");
    expect(res.grouped![1].servers.map((s) => s.name)).toEqual(["A-Ungrouped", "Z-Ungrouped"]);
  });

  it("trims group names and handles whitespace-only groups as ungrouped", () => {
    const servers = [
      { name: "Server A", group: "  Production  " },
      { name: "Server B", group: "Production" },
      { name: "Server C", group: "   " },
    ];
    const res = groupMcpServers(servers);
    expect(res.existingGroups).toEqual(["Production"]);
    expect(res.grouped).toHaveLength(2);
    expect(res.grouped![0].servers).toHaveLength(2);
    expect(res.grouped![1].name).toBe("Ungrouped");
    expect(res.grouped![1].servers).toHaveLength(1);
    expect(res.grouped![1].servers[0].name).toBe("Server C");
  });
});

describe("McpPanel - active server auto-expand & case-insensitive matching", () => {
  it("determines whether a group should be auto-expanded when active server belongs to it", () => {
    const servers = [
      { id: "srv-1", name: "DB Server", group: "Database" },
      { id: "srv-2", name: "API Server", group: "Backend" },
    ];
    const collapsed = new Set(["Database", "Backend"]);
    const activeServerId = "srv-1";

    const activeServer = servers.find((s) => s.id === activeServerId);
    expect(activeServer).toBeDefined();
    const groupName = activeServer!.group?.trim();

    if (groupName && collapsed.has(groupName)) {
      const next = new Set(collapsed);
      next.delete(groupName);
      expect(next.has("Database")).toBe(false);
      expect(next.has("Backend")).toBe(true);
    }
  });

  it("matches existing groups case-insensitively using findExistingGroupMatch", () => {
    const existingGroups = ["Database", "WebServices", "Search"];

    expect(findExistingGroupMatch("database", existingGroups)).toBe("Database");
    expect(findExistingGroupMatch(" DATABASE ", existingGroups)).toBe("Database");
    expect(findExistingGroupMatch("webservices", existingGroups)).toBe("WebServices");
    expect(findExistingGroupMatch("WeBsErViCeS", existingGroups)).toBe("WebServices");
    expect(findExistingGroupMatch("Search", existingGroups)).toBe("Search");
    expect(findExistingGroupMatch("NewGroup", existingGroups)).toBeNull();
    expect(findExistingGroupMatch("", existingGroups)).toBeNull();
    expect(findExistingGroupMatch("   ", existingGroups)).toBeNull();
  });
});

describe("McpPanel - mcpGroupSchema validation (shared from validation.ts)", () => {
  it("accepts valid group names and trims them", () => {
    expect(mcpGroupSchema.parse("  Testing Group  ")).toBe("Testing Group");
    expect(mcpGroupSchema.parse("Group1")).toBe("Group1");
  });

  it("coerces empty strings or null to null", () => {
    expect(mcpGroupSchema.parse("")).toBeNull();
    expect(mcpGroupSchema.parse("   ")).toBeNull();
    expect(mcpGroupSchema.parse(null)).toBeNull();
  });

  it("rejects group names exceeding 100 characters", () => {
    expect(() => mcpGroupSchema.parse("a".repeat(101))).toThrow("Group name must not exceed 100 characters");
    expect(mcpGroupSchema.parse("a".repeat(100))).toBe("a".repeat(100));
  });
});
