/**
 * Canonical Copilot Active Resource Schema Specifications.
 *
 * Single source of truth for all 9 symmetrically integrated modules.
 * JSON Schemas are dynamically derived from Zod contracts via z.toJSONSchema().
 */

import { z } from "zod";

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
  role: z.enum(["supervisor", "secretary", "evaluator"]).nullable().optional().describe("System role assignment"),
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
  description: z.string().optional().describe("Test scenario description"),
  scriptContent: z.string().optional().describe("Playwright automation script code"),
  assertions: z.array(z.any()).optional().describe("List of JS or LLM assertions"),
  selectedCase: z.object({
    name: z.string().max(120).optional().describe("Case name"),
    description: z.string().optional().describe("Case description"),
    scriptContent: z.string().optional().describe("Case script content"),
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
  prompt: z.string().optional().describe("User conversational turn input prompt"),
  rubric: z.string().optional().describe("Evaluation grading criteria and rubric"),
  referenceAnswer: z.string().optional().describe("Expected benchmark reference answer"),
  selectedCase: z.object({
    name: z.string().max(120).optional().describe("Case name"),
    description: z.string().optional().describe("Case description"),
    prompt: z.string().optional().describe("Case turn prompt"),
    rubric: z.string().optional().describe("Case rubric"),
    referenceAnswer: z.string().optional().describe("Case reference answer"),
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
