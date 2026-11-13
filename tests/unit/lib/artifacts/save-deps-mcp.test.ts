import { describe, expect, it, vi } from "vitest";

const { mockDbRows } = vi.hoisted(() => ({
  mockDbRows: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "vw-mcp-dev",
      group: "Hal9000",
      tools: [
        {
          name: "get_vws_id_info",
          input_schema: {
            type: "object",
            properties: { env: { type: "string" } },
            required: ["env"],
          },
        },
      ],
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "vw-mcp-att",
      group: "Medusa",
      tools: [
        {
          name: "get_vws_id_info",
          input_schema: {
            type: "object",
            properties: { env: { type: "string" } },
            required: ["env"],
          },
        },
      ],
    },
  ],
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => mockDbRows,
      }),
    }),
  },
}));

vi.mock("@/lib/builtin-tools/build-user-catalog", () => ({
  buildUserToolCatalog: async () => new Map(),
}));

import { buildProductionSaveDeps } from "@/lib/artifacts/save-deps.server";
import { canonicalize } from "@/lib/workflows/spec/canonicalize";

describe("B4: save-deps + canonicalize MCP namespace resolution", () => {
  it("resolves namespaced MCP tool to the matching server and canonicalizes inputs.name", async () => {
    const deps = buildProductionSaveDeps("user-1");

    const meta = await deps.getToolMetadata("Medusa_vw-mcp-att_get_vws_id_info");
    expect(meta).toEqual({
      source: "mcp:22222222-2222-4222-8222-222222222222",
      canonicalName: "mcp__vw-mcp-att__get_vws_id_info",
      input_schema: {
        type: "object",
        properties: { env: { type: "string" } },
        required: ["env"],
      },
    });

    const canonical = await canonicalize(
      {
        name: "Check Medusa",
        description: "Test",
        input_schema: { type: "object", properties: {} },
        nodes: [
          {
            id: 1,
            type: "tool",
            depends_on: [],
            inputs: {
              source: "builtin",
              name: "Medusa_vw-mcp-att_get_vws_id_info",
              arguments: { env: "att" },
            },
          },
        ],
        outputs: { out: "1.result" },
      },
      deps,
    );

    const node = canonical.nodes[0];
    expect(node.type).toBe("tool");
    if (node.type === "tool") {
      expect(node.inputs.source).toBe("mcp:22222222-2222-4222-8222-222222222222");
      expect(node.inputs.name).toBe("mcp__vw-mcp-att__get_vws_id_info");
      expect(
        (node.input_schema as { properties?: { name?: { const?: string } } })
          .properties?.name?.const,
      ).toBe("mcp__vw-mcp-att__get_vws_id_info");
    }
  });
});
