/**
 * MCP — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the MCP Tool Test module.
 */

export const MCP_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "mcp",
  description:
    "MCP Tool Test symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    server: {
      type: "object",
      readOnly: true,
      description: "Connected MCP Server metadata",
      properties: {
        id: { type: "string", description: "MCP Server UUID" },
        name: { type: "string", description: "MCP Server display name" },
      },
    },
    selectedTool: {
      type: "object",
      editable: true,
      description:
        "Currently active MCP tool and its input parameters under test",
      properties: {
        name: {
          type: "string",
          readOnly: true,
          description: "Name of the active tool under test",
        },
        description: {
          type: "string",
          readOnly: true,
          description: "Explanation of what the tool does",
        },
        inputSchema: {
          type: "object",
          readOnly: true,
          description:
            "JSON Schema defining expected parameter properties, types, and required fields",
        },
        args: {
          type: "object",
          editable: true,
          description:
            "Structured JSON argument payload to execute the tool with",
        },
      },
    },
    execution: {
      type: "object",
      readOnly: true,
      description:
        "Execution result and diagnostic telemetry from the most recent run",
      properties: {
        status: {
          type: "string",
          enum: ["idle", "executing", "succeeded", "failed"],
          description: "Current execution state",
        },
        durationMs: {
          type: ["integer", "null"],
          description: "Execution roundtrip time in milliseconds",
        },
        result: {
          description: "JSON output payload returned by the tool execution",
        },
        error: {
          type: ["string", "null"],
          description: "Error message if the tool call failed",
        },
      },
    },
  },
} as const;
