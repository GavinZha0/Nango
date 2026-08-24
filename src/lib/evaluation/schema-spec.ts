/**
 * Evaluation — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the Evaluation module.
 */

export const EVALUATION_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "evaluation",
  description:
    "Evaluation Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure and modify editable fields under selectedCase.",
  properties: {
    suite: {
      type: "object",
      readOnly: true,
      description: "Evaluation Suite metadata",
      properties: {
        id: { type: "string", description: "Suite UUID" },
        name: { type: "string", description: "Suite display name" },
        description: { type: "string", description: "Suite description" },
        agentId: { type: "string", description: "Target agent ID being evaluated" },
        agentSource: { type: "string", description: "Agent source ('builtin' | 'backend')" },
        evaluatorAgentId: { type: "string", description: "AI Evaluator Judge agent ID" },
        dimensionIds: {
          type: "array",
          items: { type: "string" },
          description: "Active evaluation dimensions (e.g. faithfulness, tool-correctness, tone-persona)",
        },
        caseCount: { type: "integer", description: "Total cases count in this suite" },
      },
    },
    selectedCase: {
      type: "object",
      editable: true,
      description: "Active evaluation test case being edited (null if no case is selected)",
      properties: {
        id: { type: "integer", readOnly: true, description: "Case ID" },
        suiteId: { type: "string", readOnly: true, description: "Belonging suite UUID" },
        suiteName: { type: "string", readOnly: true, description: "Suite display name" },
        name: {
          type: "string",
          editable: true,
          maxLength: 120,
          description: "Case display name",
        },
        turns: {
          type: "array",
          editable: true,
          description: "Multi-turn conversation script simulating user inputs against the target agent",
          items: {
            type: "object",
            properties: {
              userMessage: { type: "string", description: "User prompt message for this conversation turn" },
            },
            required: ["userMessage"],
          },
        },
        criteria: {
          type: "object",
          editable: true,
          description: "Evaluation rubric and checks evaluated by AI Evaluator Judge & deterministic engine",
          properties: {
            expectation: {
              type: "string",
              description: "Natural language expected outcome / response quality goals",
            },
            issue: {
              type: "string",
              description: "Reported bug or observed issue to specifically check against",
            },
            reference: { type: "string", description: "Ground truth / ideal reference answer" },
            context: {
              type: "array",
              items: { type: "string" },
              description: "Supplementary business rules & reference snippets",
            },
            assertions: {
              type: "array",
              items: { type: "string" },
              description: "Free-form assertions evaluated by LLM Judge",
            },
            expected_keywords: {
              type: "array",
              items: { type: "string" },
              description: "Keywords that MUST appear in the agent response",
            },
            unexpected_keywords: {
              type: "array",
              items: { type: "string" },
              description: "Keywords that MUST NOT appear in the agent response",
            },
            tool_calls: {
              type: "array",
              items: { type: "string" },
              description: "Tool names that the agent MUST call during conversation",
            },
            max_duration_s: { type: "number", description: "Max conversation duration limit in seconds" },
            max_output_tokens: { type: "integer", description: "Max output tokens limit" },
            max_tool_calls: { type: "integer", description: "Max tool calls count limit" },
          },
        },
        isDirty: { type: "boolean", readOnly: true, description: "Whether the case has unsaved local edits" },
      },
    },
    outcome: {
      type: "object",
      readOnly: true,
      description: "Execution diagnostics of the latest evaluation run (null if not run yet)",
      properties: {
        source: { type: "string", enum: ["live", "history"] },
        historySeq: { type: "integer", description: "Historical run sequence number (e.g. 2 for #2)" },
        status: { type: "string", enum: ["passed", "failed", "errored"] },
        score: { type: "integer", description: "Overall conversation score (0-100)" },
        dimensionScores: {
          type: "object",
          description: "Per-dimension scores (0-100), e.g. { faithfulness: 92, 'tool-correctness': 85 }",
        },
        criteriaScore: { type: "integer", description: "Criteria check score (0-100)" },
        criteriaResults: {
          type: "array",
          description:
            "Check results for each criteria item (expectation, assertions, keywords, tool calls, limits)",
        },
        feedback: {
          type: "string",
          description: "Detailed narrative feedback and scoring justification from AI Judge",
        },
      },
    },
  },
} as const;
