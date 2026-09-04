import { z } from "zod";

export type TestCategory = "verification" | "evaluation" | "web-auto";

export const testCategorySchema = z.enum(["verification", "evaluation", "web-auto"]);

export interface TesterToolContext {
  userId: string;
  isAdmin?: boolean;
  isEditor?: boolean;
}

export interface SuiteSummaryItem {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  visibility: "private" | "public";
  caseCount: number;
  // MCP server binding (verification + web-auto)
  mcpServerId?: string | null;
  serverName?: string | null;
  // Evaluation specific
  agentId?: string | null;
  agentSource?: string | null;
  evaluatorAgentId?: string | null;
  // Web Auto specific
  timeoutSec?: number | null;
}

export interface ListTestSuitesResult {
  category: TestCategory;
  total: number;
  suites: SuiteSummaryItem[];
}

export interface CaseSummaryItem {
  id: number;
  name: string;
  toolName?: string | null;
  enabled: boolean;
  assertionCount: number;
}

export interface TestSuiteDetailsResult {
  category: TestCategory;
  suite: SuiteSummaryItem;
  cases: CaseSummaryItem[];
}

export interface CaseDetailsItem {
  id: number;
  suiteId: string;
  name: string;
  enabled: boolean;
  assertions: unknown[];
  // Verification specific
  toolName?: string | null;
  input?: unknown;
  // Evaluation specific
  turns?: unknown[];
  // Web Auto specific
  script?: string | null;
  steps?: string | null;
}

export interface TestCaseDetailsResult {
  category: TestCategory;
  case: CaseDetailsItem;
}

export interface CreatedCaseItem {
  id: number;
  name: string;
  toolName?: string | null;
  enabled: false;
  assertionCount: number;
}

export interface CreateTestCasesResult {
  category: TestCategory;
  suiteId: string;
  createdCount: number;
  cases: CreatedCaseItem[];
}

export interface CreateTestSuiteResult {
  category: TestCategory;
  suite: SuiteSummaryItem;
}

export interface UpdateTestCaseResult {
  category: TestCategory;
  updated: true;
  case: CaseDetailsItem;
}

export interface DeleteTestCaseResult {
  category: TestCategory;
  deleted: true;
  caseId: number;
  suiteId: string;
  caseName: string;
}

export interface CaseAssertionResultItem {
  type: string;
  description: string;
  passed: boolean;
  message?: string | null;
}

export interface RunTestCaseResult {
  category: TestCategory;
  caseId: number;
  caseName: string;
  status: "passed" | "failed" | "errored";
  durationMs: number;
  assertionResults: CaseAssertionResultItem[];
  error?: string | null;
  score?: number | null;
  feedback?: string | null;
}

export interface RunTestSuiteResult {
  category: TestCategory;
  suiteId: string;
  suiteName: string;
  runId: string;
  status: "queued" | "running";
  totalCases: number;
  message: string;
}

export interface CaseResultDiagnosticItem {
  caseId: number;
  caseName: string;
  status: string;
  durationMs?: number | null;
  score?: number | null;
  feedback?: string | null;
  error?: string | null;
  assertionResults: CaseAssertionResultItem[];
}

export interface RunSummaryItem {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  durationMs?: number | null;
  averageScore?: number | null;
}

export interface TestRunResultItem {
  runId: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  summary: RunSummaryItem;
  cases?: CaseResultDiagnosticItem[];
}

export interface GetTestResultsResult {
  category: TestCategory;
  suiteId: string;
  suiteName: string;
  runs: TestRunResultItem[];
}

export interface McpToolSpecItem {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}

export interface GetMcpToolSchemaResult {
  mcpServerId: string;
  serverName: string;
  serverTitle: string | null;
  serverDescription: string | null;
  instructions: string | null;
  tool?: McpToolSpecItem;
  toolCount?: number;
  tools?: McpToolSpecItem[];
}

export interface GetAgentSpecResult {
  agentId: string;
  name: string;
  description: string | null;
  role: string | null;
  model: string;
  modelProvider: string;
  systemPrompt: string | null;
  tools: string[];
  skills: string[];
}

export const ASSERTION_TYPES = [
  "jsonpath",
  "json_schema",
  "js_expression",
  "tool_call",
  "metric",
  "llm_judge",
] as const;

export type AssertionTypeEnum = (typeof ASSERTION_TYPES)[number];

export interface AssertionSchemaItem {
  type: AssertionTypeEnum;
  description: string;
  jsonSchema: Record<string, unknown>;
  example: Record<string, unknown>;
}

export interface GetAssertionSchemaResult {
  category: "verification" | "evaluation" | "web-auto";
  types: AssertionTypeEnum[];
  schemas: AssertionSchemaItem[];
}
