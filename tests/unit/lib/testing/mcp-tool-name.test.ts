import { describe, expect, it, vi } from "vitest";

const { mockServer } = vi.hoisted(() => ({
  mockServer: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "vw-mcp-dev",
    group: "Hal9000",
    tools: [
      { name: "get_vws_id_info" },
      {
        name: "very_long_mcp_tool_name_that_exceeds_the_sixty_four_character_limit_alpha",
      },
    ],
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [mockServer],
        }),
      }),
    }),
  },
}));

import { toAgentToolName } from "@/lib/mcp/tool-namespace";
import { stripMcpServerToolPrefix } from "@/lib/testing/tools/mcp-tool-name";

describe("testing/tools/mcp-tool-name", () => {
  it("strips the server prefix when a tester passes the agent-facing toolName", async () => {
    await expect(
      stripMcpServerToolPrefix(
        mockServer.id,
        "Hal9000_vw-mcp-dev_get_vws_id_info",
      ),
    ).resolves.toBe("get_vws_id_info");
  });

  it("restores the full raw toolName even when the agent-facing name was 64-char truncated", async () => {
    const truncated = toAgentToolName(
      "Hal9000_vw-mcp-dev",
      "very_long_mcp_tool_name_that_exceeds_the_sixty_four_character_limit_alpha",
    );
    await expect(stripMcpServerToolPrefix(mockServer.id, truncated)).resolves.toBe(
      "very_long_mcp_tool_name_that_exceeds_the_sixty_four_character_limit_alpha",
    );
  });

  it("leaves already-raw toolNames unchanged", async () => {
    await expect(
      stripMcpServerToolPrefix(mockServer.id, "get_vws_id_info"),
    ).resolves.toBe("get_vws_id_info");
  });
});
