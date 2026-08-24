/**
 * Agent — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the Builtin Agent module.
 */

export const AGENT_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "agent",
  description:
    "Agent Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      maxLength: 120,
      description: "Agent display name",
    },
    description: {
      type: "string",
      editable: true,
      description:
        "Short explanation of the agent's purpose, specialization, and routing capabilities",
    },
    icon: {
      type: "string",
      editable: true,
      description: "Single Unicode emoji visual identifier (e.g. '📊', '🤖', '🔍')",
    },
    model: {
      type: "string",
      editable: true,
      description:
        "LLM model identifier (e.g. 'gpt-4o', 'claude-3-5-sonnet-20241022', 'deepseek-chat')",
    },
    modelProvider: {
      type: "string",
      editable: true,
      description:
        "Model provider slug (e.g. 'openai', 'anthropic', 'deepseek', 'ollama', 'gemini')",
    },
    credentialId: {
      type: "string",
      editable: true,
      description: "UUID of the bound API credential for LLM model authentication",
    },
    prompt: {
      type: "string",
      editable: true,
      description: "System prompt instructions injected into the model on every execution",
    },
    temperature: {
      type: "number",
      editable: true,
      minimum: 0,
      maximum: 1,
      description:
        "Sampling temperature between 0.0 (deterministic/strict) and 1.0 (creative/flexible)",
    },
    maxSteps: {
      type: "integer",
      editable: true,
      minimum: 1,
      maximum: 50,
      description: "Maximum number of autonomous tool-calling steps per run (default: 5)",
    },
    toolChoice: {
      type: "string",
      enum: ["auto", "required", "none"],
      editable: true,
      description:
        "Tool choice mode: 'auto' (model decides), 'required' (must call a tool), 'none' (pure chat)",
    },
    toolApprovalMode: {
      type: "string",
      enum: ["always", "auto", "never"],
      editable: true,
      description:
        "Tool execution safety gate: 'never' (autonomous), 'always' (ask user every time), 'auto' (risk-based approval)",
    },
    role: {
      type: "string",
      enum: ["supervisor", "secretary", "evaluator", null],
      editable: true,
      description:
        "Special system role assignment (supervisor/secretary/evaluator), or null for general agent",
    },
    tools: {
      type: "object",
      editable: true,
      description: "Bound capabilities and tools available to the agent",
      properties: {
        mcp: {
          type: "array",
          items: { type: "string" },
          description: "Array of bound MCP server UUIDs",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Array of bound Skill UUIDs",
        },
        builtinTools: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of bound builtin tool names (e.g. 'extract_dataset_by_sql', 'run_skill_script')",
        },
        dataSources: {
          type: "array",
          items: { type: "string" },
          description: "Array of bound Data Source UUIDs",
        },
        sshServers: {
          type: "array",
          items: { type: "string" },
          description: "Array of bound SSH Server UUIDs",
        },
        calendars: {
          type: "array",
          items: { type: "string" },
          description: "Array of bound Calendar credential UUIDs",
        },
      },
    },
  },
  required: ["name", "model", "credentialId"],
} as const;
