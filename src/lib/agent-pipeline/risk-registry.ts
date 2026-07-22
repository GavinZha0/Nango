/**
 * Agent pipeline — Tool Risk Registry and Evaluation Engine.
 *
 * Implements N1-B.1 risk-based tool classification, MCP annotation mapping
 * (readOnlyHint, destructiveHint, idempotentHint), parameter-level risk
 * escalation (assessArgs for SSH/SQL), and fail-closed / lenient MCP default policy.
 *
 * See docs/architecture-improvements.md "P1 — Safety Guardrails".
 */

import "server-only";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type SideEffects = "none" | "read" | "write" | "destructive";
export type McpDefaultPolicy = "lenient" | "annotation" | "require";

export interface ToolRiskMeta {
  /** MCP Standard Annotation: Read-only operation without side-effects */
  readonly readOnlyHint?: boolean;
  /** MCP Standard Annotation: Destructive operation (data deletion/drop/irreversible) */
  readonly destructiveHint?: boolean;
  /** MCP Standard Annotation: Idempotent operation (safe for retries) */
  readonly idempotentHint?: boolean;

  /** Platform Extension: Is this tool allowed to run in headless/scheduled mode? */
  readonly headlessAllowed?: boolean;

  /** Declared risk level and side effects */
  readonly riskLevel?: RiskLevel;
  readonly sideEffects?: SideEffects;
}

export interface ToolRiskEvaluation {
  readonly riskLevel: RiskLevel;
  readonly sideEffects: SideEffects;
  readonly requiresApproval: boolean;
  readonly headlessAllowed: boolean;
  readonly reason?: string;
}

/** Static risk definitions for Built-in tools co-located with tool definitions. */
export const BUILTIN_TOOL_RISK_MAP: ReadonlyMap<string, ToolRiskMeta> = new Map<string, ToolRiskMeta>([
  [
    "generate_echarts_config",
    { riskLevel: "low", sideEffects: "none", readOnlyHint: true, headlessAllowed: true },
  ],
  [
    "generate_html_page",
    { riskLevel: "low", sideEffects: "none", readOnlyHint: true, headlessAllowed: true },
  ],
  [
    "web_search",
    { riskLevel: "low", sideEffects: "read", readOnlyHint: true, headlessAllowed: true },
  ],
  [
    "get_current_datetime",
    { riskLevel: "low", sideEffects: "none", readOnlyHint: true, headlessAllowed: true },
  ],
  [
    "get_skill",
    { riskLevel: "low", sideEffects: "read", readOnlyHint: true, headlessAllowed: true },
  ],
  [
    "get_skill_file",
    { riskLevel: "low", sideEffects: "read", readOnlyHint: true, headlessAllowed: true },
  ],
  [
    "list_ssh_hosts",
    { riskLevel: "low", sideEffects: "read", readOnlyHint: true, headlessAllowed: true },
  ],
  [
    "run_code_in_sandbox",
    { riskLevel: "high", sideEffects: "write", headlessAllowed: true },
  ],
  [
    "run_skill_script",
    { riskLevel: "high", sideEffects: "write", headlessAllowed: true },
  ],
  [
    "extract_dataset_by_sql",
    { riskLevel: "low", sideEffects: "read", readOnlyHint: true, headlessAllowed: true },
  ],
  [
    "run_ssh_command",
    { riskLevel: "high", sideEffects: "write", headlessAllowed: false },
  ],
]);

const DANGEROUS_SSH_PATTERNS = [
  /\brm\b/i,
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\bmv\b/i,
  /\btruncate\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill\b/i,
];

const WRITE_SQL_PATTERNS = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\bcreate\b/i,
  /\btruncate\b/i,
  /\breplace\b/i,
];

/**
 * Evaluate the effective risk and approval requirement for a tool call.
 * Combines static metadata, MCP standard annotations, global MCP fallback policy,
 * and parameter-level dynamic escalation (SSH/SQL).
 */
export function evaluateToolRisk(
  toolName: string,
  args?: unknown,
  meta?: ToolRiskMeta,
  mcpDefaultPolicy: McpDefaultPolicy = "lenient",
): ToolRiskEvaluation {
  // 1. Built-in tool lookup
  const builtinMeta = BUILTIN_TOOL_RISK_MAP.get(toolName);
  const effectiveMeta: ToolRiskMeta = {
    ...builtinMeta,
    ...meta,
  };

  let riskLevel: RiskLevel = effectiveMeta.riskLevel ?? "medium";
  let sideEffects: SideEffects = effectiveMeta.sideEffects ?? "write";
  let headlessAllowed = effectiveMeta.headlessAllowed ?? true;
  let reason: string | undefined;

  // 2. Resolve MCP standard annotations if present
  if (effectiveMeta.destructiveHint === true) {
    riskLevel = "critical";
    sideEffects = "destructive";
    headlessAllowed = false;
    reason = "MCP destructiveHint is true";
  } else if (effectiveMeta.readOnlyHint === true) {
    riskLevel = "low";
    sideEffects = effectiveMeta.sideEffects ?? "read";
    headlessAllowed = true;
    reason = "MCP readOnlyHint is true";
  } else if (!builtinMeta && !meta?.riskLevel) {
    // Unannotated tool (e.g. unknown third-party MCP tool)
    if (mcpDefaultPolicy === "lenient") {
      riskLevel = "medium";
      sideEffects = "write";
      headlessAllowed = true;
      reason = "unannotated tool under lenient policy";
    } else {
      riskLevel = "high";
      sideEffects = "write";
      headlessAllowed = false;
      reason = `unannotated tool under ${mcpDefaultPolicy} policy (fail-closed)`;
    }
  }

  // 3. Dynamic parameter analysis (assessArgs) for SSH & SQL
  if (toolName === "run_ssh_command" && args && typeof args === "object") {
    const cmd = (args as { command?: unknown }).command;
    if (typeof cmd === "string" && DANGEROUS_SSH_PATTERNS.some((p) => p.test(cmd))) {
      riskLevel = "critical";
      sideEffects = "destructive";
      headlessAllowed = false;
      reason = "SSH command contains dangerous operation";
    }
  } else if (toolName === "extract_dataset_by_sql" && args && typeof args === "object") {
    const sql = (args as { sql_text?: unknown }).sql_text;
    if (typeof sql === "string" && WRITE_SQL_PATTERNS.some((p) => p.test(sql))) {
      riskLevel = "high";
      sideEffects = "write";
      reason = "SQL query contains write operation";
    }
  }

  // Approval required when risk is high or critical
  const requiresApproval = riskLevel === "high" || riskLevel === "critical";

  return {
    riskLevel,
    sideEffects,
    requiresApproval,
    headlessAllowed,
    reason,
  };
}
