/**
 * Verification — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the Verification module.
 */

export const VERIFICATION_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "verification",
  description:
    "Verification Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure and modify editable fields under selectedCase.",
  properties: {
    server: {
      type: "object",
      readOnly: true,
      description: "MCP Server metadata",
      properties: {
        id: { type: "string", description: "MCP Server UUID" },
        name: { type: "string", description: "MCP Server display name" },
        caseCount: { type: "integer", description: "Total cases count in this server" },
      },
    },
    selectedCase: {
      type: "object",
      editable: true,
      description: "Active test case being edited (null if no case is selected)",
      properties: {
        id: { type: "integer", readOnly: true, description: "Case ID" },
        suiteId: { type: "string", readOnly: true, description: "Belonging suite UUID" },
        suiteName: { type: "string", readOnly: true, description: "Suite display name" },
        toolName: { type: "string", readOnly: true, description: "Target MCP Tool name being verified" },
        name: {
          type: "string",
          editable: true,
          maxLength: 120,
          description: "Case display name",
        },
        input: {
          type: "object",
          editable: true,
          description:
            "JSON payload sent to the tool. Supports dynamic macros: {{$uuid}}, {{$uuidv7}}, {{$timestamp}}, {{$isoTimestamp}}, {{$int(min,max)}}, {{$randomString(len)}}, {{$counter}}",
        },
        assertions: {
          type: "array",
          editable: true,
          description:
            "List of assertions evaluated against tool output. Each item MUST match one of the 3 schemas below:",
          items: {
            oneOf: [
              {
                type: "object",
                description: "JSON Schema validation",
                properties: {
                  type: { type: "string", const: "json_schema" },
                  schema: { type: "object", description: "Standard JSON Schema (draft-07/2020-12)" },
                },
                required: ["type", "schema"],
              },
              {
                type: "object",
                description: "JSONPath equality assertion",
                properties: {
                  type: { type: "string", const: "jsonpath_equals" },
                  path: { type: "string", description: "JSONPath string, e.g. $.status or $.data[0].id" },
                  expected: { description: "Expected literal value (number, string, boolean, etc.)" },
                },
                required: ["type", "path", "expected"],
              },
              {
                type: "object",
                description: "JavaScript sandbox expression",
                properties: {
                  type: { type: "string", const: "js_expression" },
                  expression: {
                    type: "string",
                    maxLength: 2000,
                    description:
                      "JS boolean expression with root (full JSON output) and result (payload) bindings, e.g. root.status === 200 && result.items.length > 0",
                  },
                },
                required: ["type", "expression"],
              },
            ],
          },
        },
        isDirty: { type: "boolean", readOnly: true, description: "Whether the case has unsaved local edits" },
      },
    },
    outcome: {
      type: "object",
      readOnly: true,
      description: "Execution diagnostics of the latest run (null if not run yet)",
      properties: {
        source: { type: "string", enum: ["live", "history"] },
        historySeq: { type: "integer", description: "Historical run sequence number (e.g. 3 for #3)" },
        status: { type: "string", enum: ["passed", "failed", "errored"] },
        error: { description: "Execution error details if any" },
        verdict: { type: "object", description: "Assertion evaluations" },
        output: { description: "Sanitized tool execution output (Base64 images replaced with metadata tokens)" },
      },
    },
  },
} as const;
