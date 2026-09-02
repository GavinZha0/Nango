/**
 * Canonical Copilot Active Resource Schema Specifications.
 *
 * Single source of truth for all 9 symmetrically integrated modules.
 * JSON Schemas are dynamically derived from Zod contracts via z.toJSONSchema().
 */

import { z } from "zod";
import { evalCriteriaSchema } from "@/lib/evaluation/types";

export interface ResourceJSONSchema {
  version: "1.0";
  resourceType: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

function deriveResourceJSONSchema(
  schema: z.ZodType,
  resourceType: string,
  description: string,
): ResourceJSONSchema {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    version: "1.0" as const,
    resourceType,
    description,
    properties: (jsonSchema.properties as Record<string, unknown>) ?? {},
    ...jsonSchema,
  };
}

export const ScheduleDraftSchema = z.object({
  name: z.string().max(120).optional().describe("Schedule display name"),
  task: z.string().min(1).optional().describe("Task prompt instructions dispatched to the agent"),
  agentKey: z.string().optional().describe("Bound agent key or display name"),
  triggerMode: z.enum(["cron", "interval", "once"]).optional().describe("Trigger execution mode"),
  intervalValue: z.number().int().positive().optional().describe("Interval duration value"),
  intervalUnit: z.enum(["minute", "hour", "day", "week", "month"]).optional().describe("Interval calendar unit"),
  cronExpr: z.string().optional().describe("Standard 5-field cron expression"),
  oneShotTime: z.string().optional().describe("ISO-8601 target time for one-shot execution"),
  timezone: z.string().optional().describe("IANA timezone identifier, e.g. America/New_York"),
}).strict();

export const SkillDraftSchema = z.object({
  name: z.string().optional().describe("Skill display name (editable on creation)"),
  skillMd: z.string().optional().describe("Full SKILL.md contents including YAML frontmatter and procedure instructions"),
}).strict();

export const AgentDraftSchema = z.object({
  name: z.string().max(120).optional().describe("Agent display name"),
  description: z.string().optional().describe("Short description of the agent's role and capabilities"),
  icon: z.string().optional().describe("Emoji visual icon identifier"),
  model: z.string().optional().describe("LLM model identifier (e.g. gpt-4o, claude-3-5-sonnet)"),
  modelProvider: z.string().optional().describe("Model provider slug (e.g. openai, anthropic, deepseek)"),
  credentialId: z.string().optional().describe("UUID of the bound credential for model authentication"),
  prompt: z.string().optional().describe("System prompt instructions for this agent"),
  temperature: z.number().min(0).max(1).optional().describe("Sampling temperature between 0.0 and 1.0"),
  maxSteps: z.number().int().min(1).max(50).optional().describe("Max autonomous tool steps per run"),
  toolApprovalMode: z.enum(["always", "auto", "never"]).optional().describe("Safety gate for tool approvals"),
  role: z.enum(["supervisor", "secretary", "evaluator", "tester"]).nullable().optional().describe("System role assignment"),
  sharedStateEnabled: z.boolean().optional().describe("Whether this agent has shared state co-editing enabled"),
  tools: z.object({
    mcp: z.array(z.string()).optional().describe("Array of bound MCP server UUIDs"),
    skills: z.array(z.string()).optional().describe("Array of bound Skill UUIDs"),
    builtinTools: z.array(z.string()).optional().describe("Array of bound builtin tool names"),
    dataSources: z.array(z.string()).optional().describe("Array of bound Data Source UUIDs"),
    sshServers: z.array(z.string()).optional().describe("Array of bound SSH Server UUIDs"),
    calendars: z.array(z.string()).optional().describe("Array of bound Calendar credential UUIDs"),
  }).optional().describe("Bound capabilities and tools"),
}).strict();

export const DataSourceDraftSchema = z.object({
  name: z.string().max(63).optional().describe("Unique database identifier matching /^[a-z][a-z0-9_-]{0,62}$/"),
  description: z.string().optional().describe("Description explaining schema contents and query guidelines"),
  provider: z.enum(["postgres", "mysql", "mariadb", "vertica"]).optional().describe("Database engine dialect"),
  credentialId: z.string().optional().describe("UUID of the bound auth credential"),
  host: z.string().optional().describe("Database server hostname or IP"),
  port: z.number().int().min(1).max(65535).optional().describe("Connection port"),
  database: z.string().optional().describe("Target database or catalog name"),
  params: z.record(z.string(), z.unknown()).optional().describe("Extra connection parameters"),
  readOnly: z.boolean().optional().describe("When true, enforces read-only access via SQL query analysis"),
  tableAllowlist: z.array(z.string()).nullable().optional().describe("List of permitted table names"),
  tableDenylist: z.array(z.string()).nullable().optional().describe("List of prohibited table names"),
}).strict();

export const SshServerDraftSchema = z.object({
  name: z.string().max(63).optional().describe("SSH server display name"),
  description: z.string().optional().describe("Server role description and command policies"),
  credentialId: z.string().optional().describe("UUID of the bound SSH credential"),
  host: z.string().optional().describe("SSH host address"),
  port: z.number().int().min(1).max(65535).optional().describe("SSH port (default: 22)"),
  knownHostFingerprint: z.string().nullable().optional().describe("Public host key fingerprint"),
  commandAllow: z.array(z.string()).optional().describe("List of permitted command regex patterns"),
  commandApprove: z.array(z.string()).optional().describe("List of commands requiring manual approval"),
  commandDeny: z.array(z.string()).optional().describe("List of strictly denied command patterns"),
  loginShell: z.string().optional().describe("Login shell (e.g. /bin/bash, /bin/sh)"),
}).strict();

export const McpDraftSchema = z.object({
  selectedToolName: z.string().optional().describe("Selected tool name in MCP testing panel"),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments passed to the tool"),
}).strict();

export const WebAutoDraftSchema = z.object({
  name: z.string().max(120).optional().describe("Test case display name"),
  input: z.object({
    script: z.string().optional().describe("Playwright automation script code"),
    steps: z.string().optional().describe("Natural language test steps"),
  }).passthrough().optional().describe("Test case input containing script and steps"),
  assertions: z.array(z.any()).optional().describe("List of JS or LLM assertions"),
  selectedCase: z.object({
    name: z.string().max(120).optional().describe("Case name"),
    input: z.object({
      script: z.string().optional().describe("Script code"),
      steps: z.string().optional().describe("Test steps"),
    }).passthrough().optional().describe("Case input data"),
    assertions: z.array(z.any()).optional().describe("Case assertions"),
  }).optional().describe("Selected case data"),
}).strict();

export const VerificationDraftSchema = z.object({
  name: z.string().max(120).optional().describe("Verification case display name"),
  description: z.string().optional().describe("Case goal and scenario"),
  input: z.record(z.string(), z.unknown()).optional().describe("Input arguments payload"),
  assertions: z.union([z.string(), z.array(z.any())]).optional().describe("Output assertion rules"),
  selectedCase: z.object({
    name: z.string().max(120).optional().describe("Case name"),
    description: z.string().optional().describe("Case description"),
    input: z.record(z.string(), z.unknown()).optional().describe("Case input payload"),
    assertions: z.union([z.string(), z.array(z.any())]).optional().describe("Case assertions"),
  }).optional().describe("Selected case data"),
}).strict();

export const EvaluationDraftSchema = z.object({
  name: z.string().max(120).optional().describe("Evaluation case display name"),
  description: z.string().optional().describe("Case description"),
  input: z.object({
    turns: z.array(z.object({
      userMessage: z.string().min(1).describe("User message input for this turn"),
      expectedOutput: z.string().optional().describe("Expected assistant response or outcome"),
    })).optional(),
  }).passthrough().optional().describe("Case input structure"),
  assertions: z.union([z.string(), z.array(z.any())]).optional().describe("Case assertions list"),
  turns: z.array(z.object({
    userMessage: z.string().min(1).describe("User message input for this turn"),
    expectedOutput: z.string().optional().describe("Expected assistant response or outcome"),
  })).optional().describe("Conversation turns list"),
  criteria: evalCriteriaSchema.optional().describe("Evaluation criteria and constraints"),
  selectedCase: z.object({
    name: z.string().max(120).optional().describe("Case name"),
    description: z.string().optional().describe("Case description"),
    input: z.record(z.string(), z.unknown()).optional(),
    assertions: z.union([z.string(), z.array(z.any())]).optional(),
    turns: z.array(z.object({
      userMessage: z.string().min(1),
      expectedOutput: z.string().optional(),
    })).optional(),
    criteria: evalCriteriaSchema.optional(),
  }).optional().describe("Selected case data"),
}).strict();

export const DRAFT_SCHEMAS = {
  schedule: ScheduleDraftSchema,
  skills: SkillDraftSchema,
  agent: AgentDraftSchema,
  datasource: DataSourceDraftSchema,
  "ssh-server": SshServerDraftSchema,
  mcp: McpDraftSchema,
  "web-auto": WebAutoDraftSchema,
  verification: VerificationDraftSchema,
  evaluation: EvaluationDraftSchema,
} as const;

// ─── Zod-derived JSON Schema Single Source of Truth ─────────────────────────

export const SCHEDULE_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  ScheduleDraftSchema,
  "schedule",
  "Schedule Editor symmetric state contract.",
);

export const SKILL_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  SkillDraftSchema,
  "skills",
  "Skill Editor symmetric state contract.",
);

export const AGENT_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  AgentDraftSchema,
  "agent",
  "Agent Editor symmetric state contract.",
);

export const DATASOURCE_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  DataSourceDraftSchema,
  "datasource",
  "DataSource Editor symmetric state contract.",
);

export const SSH_SERVER_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  SshServerDraftSchema,
  "ssh-server",
  "SSH Server Editor symmetric state contract.",
);

export const MCP_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  McpDraftSchema,
  "mcp",
  "MCP Test Panel symmetric state contract.",
);

export const WEB_AUTO_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  WebAutoDraftSchema,
  "web-auto",
  "Web Auto Editor symmetric state contract.",
);

export const VERIFICATION_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  VerificationDraftSchema,
  "verification",
  "Verification Suite Editor symmetric state contract.",
);

export const EVALUATION_ACTIVE_RESOURCE_SCHEMA = deriveResourceJSONSchema(
  EvaluationDraftSchema,
  "evaluation",
  "Evaluation Suite Editor symmetric state contract.",
);

interface JSONSchemaProp {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, JSONSchemaProp>;
  items?: JSONSchemaProp;
  description?: string;
}

function formatPropertyContract(key: string, prop: JSONSchemaProp): string {
  // 1. Enum constraints
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const validEnums = prop.enum.filter((v) => v !== null);
    return `\`${key}\` (enum: ${validEnums.map((e) => `"${e}"`).join(" | ")})`;
  }

  // 2. String constraints (maxLength, minLength)
  if (prop.type === "string") {
    const constraints: string[] = [];
    if (prop.maxLength !== undefined) constraints.push(`max: ${prop.maxLength}`);
    if (prop.minLength !== undefined) constraints.push(`min: ${prop.minLength}`);
    return `\`${key}\` (string${constraints.length > 0 ? `, ${constraints.join(", ")}` : ""})`;
  }

  // 3. Number & integer ranges
  if (prop.type === "number" || prop.type === "integer") {
    const isInt = prop.type === "integer";
    if (prop.minimum !== undefined && prop.maximum !== undefined) {
      return `\`${key}\` (${isInt ? "int" : "number"}, ${prop.minimum}-${prop.maximum})`;
    }
    if (prop.minimum !== undefined) {
      return `\`${key}\` (${isInt ? "int" : "number"}, min: ${prop.minimum})`;
    }
    if (prop.maximum !== undefined) {
      return `\`${key}\` (${isInt ? "int" : "number"}, max: ${prop.maximum})`;
    }
    return `\`${key}\` (${isInt ? "int" : "number"})`;
  }

  // 4. Boolean
  if (prop.type === "boolean") {
    return `\`${key}\` (boolean)`;
  }

  // 5. Array
  if (prop.type === "array") {
    const itemType = prop.items?.type === "string" ? "string[]" : "array";
    return `\`${key}\` (${itemType})`;
  }

  // 6. Object (with nested properties)
  if (prop.type === "object" && prop.properties) {
    const subKeys = Object.keys(prop.properties).map((k) => `\`${k}\``).join(", ");
    return `\`${key}\` (object with ${subKeys})`;
  }

  return `\`${key}\` (object)`;
}

/**
 * Dynamically builds the Markdown Compact Draft Contracts block from Zod-derived JSON schemas.
 * Guarantees zero drift between runtime Zod validation and system prompt instructions.
 */
export function buildResourceDraftContractsBlock(): string {
  const lines: string[] = [
    "### Resource Draft Contracts (Allowed Fields & Constraints)",
  ];

  const schemas: Array<{ type: string; schema: ResourceJSONSchema }> = [
    { type: "schedule", schema: SCHEDULE_ACTIVE_RESOURCE_SCHEMA },
    { type: "skills", schema: SKILL_ACTIVE_RESOURCE_SCHEMA },
    { type: "agent", schema: AGENT_ACTIVE_RESOURCE_SCHEMA },
    { type: "datasource", schema: DATASOURCE_ACTIVE_RESOURCE_SCHEMA },
    { type: "ssh-server", schema: SSH_SERVER_ACTIVE_RESOURCE_SCHEMA },
    { type: "mcp", schema: MCP_ACTIVE_RESOURCE_SCHEMA },
    { type: "web-auto", schema: WEB_AUTO_ACTIVE_RESOURCE_SCHEMA },
    { type: "verification", schema: VERIFICATION_ACTIVE_RESOURCE_SCHEMA },
    { type: "evaluation", schema: EVALUATION_ACTIVE_RESOURCE_SCHEMA },
  ];

  for (const { type, schema } of schemas) {
    const props = schema.properties || {};
    const fieldContracts = Object.entries(props)
      .map(([key, prop]) => formatPropertyContract(key, prop as JSONSchemaProp))
      .join(", ");
    lines.push(`- **\`${type}\`**: ${fieldContracts}.`);
  }

  return lines.join("\n");
}

export const RESOURCE_DRAFT_CONTRACTS_BLOCK: string = buildResourceDraftContractsBlock();
