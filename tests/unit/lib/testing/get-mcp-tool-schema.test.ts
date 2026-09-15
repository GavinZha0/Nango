import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getMcpToolSchemaSchema,
  buildGetMcpToolSchemaTool,
} from "@/lib/testing/tools/get-mcp-tool-schema";
import type { GetMcpToolSchemaResult } from "@/lib/testing/types";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
import type { MockDrizzleDb } from "tests/unit/helpers";

const dbMock = db as unknown as MockDrizzleDb;

describe("get_mcp_tool_schema tool", () => {
  const validMcpServerId = "a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d";

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
  });

  describe("Schema Validation", () => {
    it("accepts valid mcpServerId", () => {
      const parsed = getMcpToolSchemaSchema.safeParse({
        mcpServerId: validMcpServerId,
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts valid mcpServerId with toolName", () => {
      const parsed = getMcpToolSchemaSchema.safeParse({
        mcpServerId: validMcpServerId,
        toolName: "list_tables",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts valid mcpServerId with empty string, whitespace, or null toolName by normalizing to undefined", () => {
      const emptyParsed = getMcpToolSchemaSchema.safeParse({
        mcpServerId: validMcpServerId,
        toolName: "",
      });
      expect(emptyParsed.success).toBe(true);
      if (emptyParsed.success) {
        expect(emptyParsed.data.toolName).toBeUndefined();
      }

      const whitespaceParsed = getMcpToolSchemaSchema.safeParse({
        mcpServerId: validMcpServerId,
        toolName: "   ",
      });
      expect(whitespaceParsed.success).toBe(true);
      if (whitespaceParsed.success) {
        expect(whitespaceParsed.data.toolName).toBeUndefined();
      }

      const nullParsed = getMcpToolSchemaSchema.safeParse({
        mcpServerId: validMcpServerId,
        toolName: null,
      });
      expect(nullParsed.success).toBe(true);
      if (nullParsed.success) {
        expect(nullParsed.data.toolName).toBeUndefined();
      }
    });

    it("rejects missing mcpServerId", () => {
      const parsed = getMcpToolSchemaSchema.safeParse({});
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid UUID strings", () => {
      const parsed = getMcpToolSchemaSchema.safeParse({
        mcpServerId: "invalid-uuid",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("Execution", () => {
    const mockMcpTools = [
      {
        name: "list_records",
        description: "List database records",
        input_schema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
        enabled: true,
      },
      {
        name: "delete_record",
        description: "Delete a record",
        input_schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        enabled: true,
      },
    ];

    it("throws error if MCP server not found or access denied", async () => {
      dbMock.$enqueue([]);

      const tool = buildGetMcpToolSchemaTool({ userId: "user-1" });
      await expect(
        tool.execute!({ mcpServerId: validMcpServerId }),
      ).rejects.toThrow(/not found or access denied/i);
    });

    it("returns lightweight tool list when toolName is omitted", async () => {
      dbMock.$enqueue([
        {
          id: validMcpServerId,
          name: "postgres-mcp",
          serverTitle: "PostgreSQL Server",
          serverDescription: "Direct DB interface",
          instructions: "Use parameterized queries",
          tools: mockMcpTools,
        },
      ]);

      const tool = buildGetMcpToolSchemaTool({ userId: "user-1" });
      const result = (await tool.execute!({
        mcpServerId: validMcpServerId,
      })) as GetMcpToolSchemaResult;

      expect(result.mcpServerId).toBe(validMcpServerId);
      expect(result.serverName).toBe("postgres-mcp");
      expect(result.serverTitle).toBe("PostgreSQL Server");
      expect(result.toolCount).toBe(2);
      expect(result.tools).toHaveLength(2);
      expect(result.tools?.[0]).toEqual({
        name: "list_records",
        description: "List database records",
        enabled: true,
      });
      expect(result.tools?.[1]).toEqual({
        name: "delete_record",
        description: "Delete a record",
        enabled: true,
      });
      // inputSchema must not be leaked in list mode to save tokens
      expect("inputSchema" in (result.tools?.[0] ?? {})).toBe(false);
      expect(result.tool).toBeUndefined();
    });

    it("returns lightweight tool list when toolName is empty string", async () => {
      dbMock.$enqueue([
        {
          id: validMcpServerId,
          name: "postgres-mcp",
          serverTitle: "PostgreSQL Server",
          serverDescription: "Direct DB interface",
          instructions: "Use parameterized queries",
          tools: mockMcpTools,
        },
      ]);

      const tool = buildGetMcpToolSchemaTool({ userId: "user-1" });
      const parsedArgs = getMcpToolSchemaSchema.parse({
        mcpServerId: validMcpServerId,
        toolName: "",
      });
      const result = (await tool.execute!(parsedArgs)) as GetMcpToolSchemaResult;

      expect(result.mcpServerId).toBe(validMcpServerId);
      expect(result.serverName).toBe("postgres-mcp");
      expect(result.toolCount).toBe(2);
      expect(result.tools).toHaveLength(2);
      expect("inputSchema" in (result.tools?.[0] ?? {})).toBe(false);
      expect(result.tool).toBeUndefined();
    });

    it("returns specific tool schema when toolName is provided", async () => {
      dbMock.$enqueue([
        {
          id: validMcpServerId,
          name: "postgres-mcp",
          serverTitle: "PostgreSQL Server",
          serverDescription: "Direct DB interface",
          instructions: "Use parameterized queries",
          tools: mockMcpTools,
        },
      ]);

      const tool = buildGetMcpToolSchemaTool({ userId: "user-1" });
      const result = (await tool.execute!({
        mcpServerId: validMcpServerId,
        toolName: "delete_record",
      })) as GetMcpToolSchemaResult;

      expect(result.mcpServerId).toBe(validMcpServerId);
      expect(result.serverName).toBe("postgres-mcp");
      expect(result.tool).toBeDefined();
      expect(result.tool?.name).toBe("delete_record");
      expect(result.tool?.inputSchema).toEqual({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      });
      expect(result.tools).toBeUndefined();
    });

    it("throws descriptive error when toolName does not exist on server", async () => {
      dbMock.$enqueue([
        {
          id: validMcpServerId,
          name: "postgres-mcp",
          tools: mockMcpTools,
        },
      ]);

      const tool = buildGetMcpToolSchemaTool({ userId: "user-1" });
      await expect(
        tool.execute!({
          mcpServerId: validMcpServerId,
          toolName: "unknown_tool",
        }),
      ).rejects.toThrow(/Tool 'unknown_tool' not found in MCP Server 'postgres-mcp'/);
    });
  });
});
