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
  // Verification specific
  serverId?: string | null;
  serverName?: string | null;
  // Evaluation specific
  agentId?: string | null;
  agentSource?: string | null;
  evaluatorAgentId?: string | null;
  // Web Auto specific
  mcpServerId?: string | null;
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
  steps?: unknown[] | null;
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
