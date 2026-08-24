/**
 * Web Auto — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the Web Auto module.
 */

export const WEB_AUTO_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "web-auto",
  description:
    "Web Auto Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure and modify editable fields under selectedCase.",
  properties: {
    suite: {
      type: "object",
      readOnly: true,
      description: "Web Auto Suite metadata",
      properties: {
        id: { type: "string", description: "Suite UUID" },
        name: { type: "string", description: "Suite display name" },
        description: { type: "string", description: "Suite description" },
        timeoutSec: { type: "integer", description: "Execution timeout in seconds" },
        caseCount: { type: "integer", description: "Total cases count in this suite" },
      },
    },
    selectedCase: {
      type: "object",
      editable: true,
      description: "Active Web Auto test case being edited (null if no case is selected)",
      properties: {
        id: { type: "string", readOnly: true, description: "Case UUID" },
        name: {
          type: "string",
          editable: true,
          maxLength: 120,
          description: "Case display name",
        },
        description: {
          type: "string",
          editable: true,
          description: "Natural language test goal or user scenario description",
        },
        scriptContent: {
          type: "string",
          editable: true,
          description:
            "Playwright browser automation script (JavaScript/TypeScript with page API, e.g. await page.goto(...))",
        },
        assertions: {
          type: "array",
          editable: true,
          description:
            "Assertions evaluated after script finishes. Each item MUST match one of the assertion types below:",
          items: {
            oneOf: [
              {
                type: "object",
                description: "Deterministic JS expression assertion in VM sandbox",
                properties: {
                  type: { type: "string", const: "js_expression" },
                  expression: {
                    type: "string",
                    maxLength: 2000,
                    description:
                      "JS boolean expression with result (script return value) and root (full output JSON) bindings, e.g. result.success === true && root.title.includes('Dashboard')",
                  },
                },
                required: ["type", "expression"],
              },
              {
                type: "object",
                description: "LLM Judge natural language expectation evaluation",
                properties: {
                  type: { type: "string", const: "llm_expectation" },
                  expectation: {
                    type: "string",
                    description:
                      "Natural language criteria assessed by AI Evaluator against page content and execution logs, e.g. The user profile avatar and email are visibly updated",
                  },
                },
                required: ["type", "expectation"],
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
      description: "Execution diagnostics of the latest browser run (null if not run yet)",
      properties: {
        source: { type: "string", enum: ["live", "history"] },
        historySeq: { type: "integer", description: "Historical run sequence number (e.g. 6 for #6)" },
        status: { type: "string", enum: ["passed", "failed", "errored"] },
        error: { description: "Execution error details if any" },
        verdict: { type: "object", description: "Assertion verdicts and evaluator grades" },
        output: {
          description:
            "Sanitized Playwright execution output (Base64 screenshots replaced with metadata tokens, preserving logs/data)",
        },
      },
    },
  },
} as const;
