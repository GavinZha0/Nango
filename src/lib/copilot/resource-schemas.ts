/**
 * Canonical Copilot Active Resource Schema Specifications.
 *
 * Centralized structural contracts for all 9 symmetrically integrated modules.
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
    sharedStateEnabled: {
      type: "boolean",
      editable: true,
      description: "Whether this agent has read/write access to shared editor state (Copilot Mode)",
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

export const DATASOURCE_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "datasource",
  description:
    "DataSource Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      maxLength: 63,
      description:
        "Unique database identifier matching /^[a-z][a-z0-9_-]{0,62}$/ (e.g. 'analytics_prod', 'sales_db')",
    },
    description: {
      type: "string",
      editable: true,
      description:
        "Description injected into agent system prompt explaining schema contents, business domain, and query guidelines",
    },
    provider: {
      type: "string",
      enum: ["postgres", "mysql", "mariadb", "vertica"],
      editable: true,
      description: "Database engine dialect",
    },
    credentialId: {
      type: "string",
      editable: true,
      description:
        "UUID of the bound credential storing username and password",
    },
    host: {
      type: "string",
      editable: true,
      description: "Database server hostname or IP address",
    },
    port: {
      type: "integer",
      editable: true,
      minimum: 1,
      maximum: 65535,
      description:
        "Connection port (e.g. 5432 for PostgreSQL, 3306 for MySQL)",
    },
    database: {
      type: "string",
      editable: true,
      description: "Target database or catalog name",
    },
    params: {
      type: "object",
      editable: true,
      description:
        "Key-value map of extra connection parameters (e.g. {'sslmode': 'require', 'connectTimeout': '10'})",
    },
    readOnly: {
      type: "boolean",
      editable: true,
      description:
        "When true, enforces read-only access via SQL statement analysis and transaction constraints (default: true)",
    },
    tableAllowlist: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of permitted table names (null or empty array allows all tables)",
    },
    tableDenylist: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of denied table names (takes precedence over allowlist)",
    },
  },
  required: ["name", "provider", "credentialId", "host", "port", "database"],
} as const;

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

export const SCHEDULE_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "schedule",
  description:
    "Schedule Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      maxLength: 120,
      description: "Optional human-readable schedule title (e.g. 'Daily Market Digest')",
    },
    task: {
      type: "string",
      editable: true,
      description: "The prompt instruction dispatched to the target agent on each scheduled tick",
    },
    agentKey: {
      type: "string",
      editable: true,
      description: "Target agent identifier in 'builtin:<agentId>' or '<credentialId>:<entityId>' format",
    },
    triggerMode: {
      type: "string",
      enum: ["one_shot", "recurring"],
      editable: true,
      description: "Trigger strategy: 'one_shot' for one-time execution, 'recurring' for periodic repeats",
    },
    intervalValue: {
      type: "string",
      editable: true,
      description: "Repeat interval integer value (e.g. '1', '2', '12'). Required when triggerMode is 'recurring'",
    },
    intervalUnit: {
      type: "string",
      enum: ["minute", "hour", "day", "week", "month"],
      editable: true,
      description: "Repeat interval calendar unit. Required when triggerMode is 'recurring'",
    },
    startLocal: {
      type: "string",
      editable: true,
      description: "First run datetime in local 'YYYY-MM-DDTHH:mm' format (e.g. '2026-08-25T09:00') or ISO 8601 UTC string",
    },
    endLocal: {
      type: "string",
      editable: true,
      description: "Optional end datetime window in local 'YYYY-MM-DDTHH:mm' format (or empty string/null if open-ended)",
    },
    timezone: {
      type: "string",
      editable: true,
      description: "IANA timezone string (e.g. 'Asia/Shanghai', 'America/New_York', 'UTC')",
    },
  },
  required: ["task", "triggerMode", "startLocal"],
} as const;

export const SKILL_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "skills",
  description:
    "Skill Editor symmetric state contract. Builtin skills are immutable (read-only); custom skills allow editing skillMd. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      description:
        "Skill unique slug identifier (e.g. 'csv-analyst', 'pdf-extractor'). Editable on creation, immutable once created.",
    },
    source: {
      type: "string",
      enum: ["builtin", "local"],
      readOnly: true,
      description:
        "Origin of the skill: 'builtin' (system-seeded, immutable) vs 'local' (custom user-created).",
    },
    isReadOnly: {
      type: "boolean",
      readOnly: true,
      description:
        "Indicates whether this skill is locked against edits (true for builtin skills).",
    },
    skillMd: {
      type: "string",
      editable: true,
      description:
        "Complete SKILL.md text containing YAML frontmatter (name, description, version) and Markdown procedure instructions.",
    },
  },
  required: ["name", "skillMd"],
} as const;

export const SSH_SERVER_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "ssh-server",
  description:
    "SSH Server Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      maxLength: 63,
      description:
        "Unique SSH host identifier matching /^[a-z][a-z0-9_-]{0,62}$/ (e.g. 'prod_web_01', 'bastion_host')",
    },
    description: {
      type: "string",
      editable: true,
      description:
        "Description injected into agent system prompt explaining server purpose, OS environment, and allowed operations",
    },
    credentialId: {
      type: "string",
      editable: true,
      description:
        "UUID of the bound SSH credential containing username and password or private key",
    },
    host: {
      type: "string",
      editable: true,
      description: "SSH server hostname or IP address",
    },
    port: {
      type: "integer",
      editable: true,
      minimum: 1,
      maximum: 65535,
      description: "SSH connection port (default: 22)",
    },
    knownHostFingerprint: {
      type: "string",
      editable: true,
      description:
        "Pinned host-key fingerprint matching /^SHA256:[A-Za-z0-9+/=]+$/ for MITM security verification",
    },
    commandAllow: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of allowed command regex patterns (null or empty array allows all commands)",
    },
    commandApprove: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of command regex patterns requiring interactive user approval before execution",
    },
    commandDeny: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of forbidden command regex patterns (takes precedence over allowlist)",
    },
    loginShell: {
      type: "boolean",
      editable: true,
      description:
        "When true, wraps commands as 'bash -lc' to source login environment profile scripts (default: true)",
    },
  },
  required: ["name", "credentialId", "host", "port", "knownHostFingerprint"],
} as const;

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
