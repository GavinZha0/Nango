import { describe, expect, it, vi } from "vitest";

import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";
import {
  buildMcpToolPrefix,
  getMcpToolMeta,
  MAX_AGENT_TOOL_NAME_LENGTH,
  MAX_PREFIX_LENGTH,
  namespaceMcpProvider,
  resolveAgentMcpPrefixes,
  toAgentToolName,
} from "@/lib/mcp/tool-namespace";

describe("mcp/tool-namespace", () => {
  describe("buildMcpToolPrefix", () => {
    it("joins group and name with underscore", () => {
      expect(
        buildMcpToolPrefix({
          serverId: "11111111-1111-1111-1111-111111111111",
          group: "Hal9000",
          name: "vw-mcp-dev",
        }),
      ).toBe("Hal9000_vw-mcp-dev");
    });

    it("uses only name when group is empty or null", () => {
      expect(
        buildMcpToolPrefix({
          serverId: "11111111-1111-1111-1111-111111111111",
          group: "   ",
          name: "playwright",
        }),
      ).toBe("playwright");
      expect(
        buildMcpToolPrefix({
          serverId: "11111111-1111-1111-1111-111111111111",
          group: null,
          name: "playwright",
        }),
      ).toBe("playwright");
    });

    it("sanitizes illegal characters, collapses underscores, and trims edges", () => {
      expect(
        buildMcpToolPrefix({
          serverId: "11111111-1111-1111-1111-111111111111",
          group: "  --Prod / East!! ",
          name: "  @api..server__ ",
        }),
      ).toBe("Prod_East_api_server");
    });

    it("falls back to mcp-<serverId[:6]> when group and name have no ASCII identifier chars", () => {
      expect(
        buildMcpToolPrefix({
          serverId: "abcdef12-3456-7890-abcd-ef1234567890",
          group: "生产环境",
          name: "核心服务",
        }),
      ).toBe("mcp-abcdef");
    });

    it("truncates prefixes longer than 24 chars with deterministic 6-char hash", () => {
      const a = buildMcpToolPrefix({
        serverId: "11111111-1111-1111-1111-111111111111",
        group: "ProductionCluster",
        name: "VeryLongServiceNameAlpha",
      });
      const b = buildMcpToolPrefix({
        serverId: "11111111-1111-1111-1111-111111111111",
        group: "ProductionCluster",
        name: "VeryLongServiceNameBeta",
      });

      expect(a.length).toBeLessThanOrEqual(MAX_PREFIX_LENGTH);
      expect(b.length).toBeLessThanOrEqual(MAX_PREFIX_LENGTH);
      expect(a).toMatch(/^[A-Za-z0-9_-]+-[0-9a-z]{6}$/);
      expect(a).not.toBe(b);
    });
  });

  describe("resolveAgentMcpPrefixes", () => {
    it("disambiguates colliding prefixes deterministically by serverId while staying <= 24 chars", () => {
      const idA = "aaaa1111-0000-0000-0000-000000000001";
      const idB = "bbbb2222-0000-0000-0000-000000000002";

      const map1 = resolveAgentMcpPrefixes([
        { serverId: idB, group: "Hal9000", name: "vw-mcp" },
        { serverId: idA, group: "Hal9000", name: "vw-mcp" },
      ]);
      const map2 = resolveAgentMcpPrefixes([
        { serverId: idA, group: "Hal9000", name: "vw-mcp" },
        { serverId: idB, group: "Hal9000", name: "vw-mcp" },
      ]);

      expect(map1.get(idA)).toBe("Hal9000_vw-mcp");
      expect(map1.get(idB)).toBe("Hal9000_vw-mcp-bbbb");
      expect(map1).toEqual(map2);
    });

    it("keeps disambiguated long prefixes within 24 chars", () => {
      const idA = "11110000-0000-0000-0000-000000000001";
      const idB = "22220000-0000-0000-0000-000000000002";

      const map = resolveAgentMcpPrefixes([
        { serverId: idA, group: "VeryLongGroupName", name: "VeryLongServerName" },
        { serverId: idB, group: "VeryLongGroupName", name: "VeryLongServerName" },
      ]);

      expect(map.get(idA)!.length).toBeLessThanOrEqual(MAX_PREFIX_LENGTH);
      expect(map.get(idB)!.length).toBeLessThanOrEqual(MAX_PREFIX_LENGTH);
      expect(map.get(idA)).not.toBe(map.get(idB));
    });
  });

  describe("toAgentToolName", () => {
    it("formats <prefix>_<rawToolName> and enforces 64-char limit", () => {
      expect(toAgentToolName("Hal9000_vw-mcp-dev", "get_vws_id_info")).toBe(
        "Hal9000_vw-mcp-dev_get_vws_id_info",
      );

      const longA = toAgentToolName(
        "Hal9000_vw-mcp-dev",
        "very_long_mcp_tool_name_that_exceeds_the_sixty_four_character_limit_alpha",
      );
      const longB = toAgentToolName(
        "Hal9000_vw-mcp-dev",
        "very_long_mcp_tool_name_that_exceeds_the_sixty_four_character_limit_beta",
      );

      expect(longA.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_NAME_LENGTH);
      expect(longB.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_NAME_LENGTH);
      expect(longA).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(longA).not.toBe(longB);
    });
  });

  describe("namespaceMcpProvider", () => {
    it("renames tool keys, attaches origin metadata, and preserves raw execute behavior", async () => {
      const callTool = vi.fn(async (rawName: string, args: unknown) => ({ rawName, args }));
      const provider: GracefulMcpProvider = {
        label: "vw-mcp-dev",
        health: "ready",
        lastErrorMessage: null,
        close: vi.fn(async () => {}),
        tools: vi.fn(async () => ({
          get_vws_id_info: {
            name: "get_vws_id_info",
            description: "Get VWS ID info",
            execute: (args: unknown) => callTool("get_vws_id_info", args),
          },
        })) as unknown as GracefulMcpProvider["tools"],
      };

      const wrapped = namespaceMcpProvider(provider, {
        serverId: "11111111-1111-1111-1111-111111111111",
        prefix: "Hal9000_vw-mcp-dev",
      });

      const tools = (await wrapped.tools()) as unknown as Record<
        string,
        { name: string; execute: (args: unknown) => Promise<unknown> }
      >;

      expect(Object.keys(tools)).toEqual(["Hal9000_vw-mcp-dev_get_vws_id_info"]);
      const tool = tools["Hal9000_vw-mcp-dev_get_vws_id_info"];
      expect(tool.name).toBe("Hal9000_vw-mcp-dev_get_vws_id_info");
      expect(getMcpToolMeta(tool)).toEqual({
        source: "mcp",
        mcpServerId: "11111111-1111-1111-1111-111111111111",
        rawToolName: "get_vws_id_info",
      });

      const res = await tool.execute({ id: 42 });
      expect(callTool).toHaveBeenCalledWith("get_vws_id_info", { id: 42 });
      expect(res).toEqual({ rawName: "get_vws_id_info", args: { id: 42 } });
    });

    it("returns empty object when upstream tools() is empty", async () => {
      const provider: GracefulMcpProvider = {
        label: "empty-mcp",
        health: "ready",
        lastErrorMessage: null,
        close: vi.fn(async () => {}),
        tools: vi.fn(async () => ({})) as GracefulMcpProvider["tools"],
      };

      const wrapped = namespaceMcpProvider(provider, {
        serverId: "11111111-1111-1111-1111-111111111111",
        prefix: "empty-mcp",
      });

      expect(await wrapped.tools()).toEqual({});
    });
  });
});
