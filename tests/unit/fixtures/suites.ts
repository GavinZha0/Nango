/**
 * Shared test fixtures and factory helpers for Verification, WebAuto, and Eval Suites.
 */

import type {
  VerificationSuiteEntity,
  WebAutoSuiteEntity,
  EvalSuiteEntity,
} from "@/lib/db/schema";

let suiteSeq = 1;

function makeSeqUuid(prefix: string, seq: number): string {
  const hex = seq.toString(16).padStart(12, "0");
  return `${prefix}-0000-4000-8000-${hex}`;
}

export function createMockVerificationSuite(
  overrides: Partial<VerificationSuiteEntity> = {},
): VerificationSuiteEntity {
  const seq = suiteSeq++;
  const id = overrides.id ?? makeSeqUuid("01918a3b", seq);
  return {
    id,
    name: `Verification Suite ${seq}`,
    description: `Test verification suite ${seq}`,
    category: "mcp",
    mcpServerId: makeSeqUuid("01918a3c", seq),
    mcpServerName: `MCP Server ${seq}`,
    workflowId: null,
    enabled: true,
    visibility: "private",
    timeoutSec: 300,
    createdBy: "user-editor-1",
    updatedBy: "user-editor-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function createMockWebAutoSuite(
  overrides: Partial<WebAutoSuiteEntity> = {},
): WebAutoSuiteEntity {
  const seq = suiteSeq++;
  const id = overrides.id ?? makeSeqUuid("01918a3d", seq);
  return {
    id,
    parentId: null,
    name: `Web Auto Suite ${seq}`,
    description: `Web auto suite description ${seq}`,
    variables: {},
    enabled: true,
    visibility: "private",
    timeoutSec: 300, // Aligned with schema.ts default of 300 seconds
    evaluatorAgentId: null,
    mcpServerId: makeSeqUuid("01918a3c", seq),
    createdBy: "user-editor-1",
    updatedBy: "user-editor-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function createMockEvalSuite(
  overrides: Partial<EvalSuiteEntity> = {},
): EvalSuiteEntity {
  const seq = suiteSeq++;
  const id = overrides.id ?? makeSeqUuid("01918a3e", seq);
  return {
    id,
    name: `Evaluation Suite ${seq}`,
    description: `Eval suite description ${seq}`,
    agentId: makeSeqUuid("01918a3f", seq),
    agentSource: "builtin",
    evaluatorAgentId: null,
    dimensionIds: [],
    credentialId: null,
    visibility: "private",
    enabled: true,
    createdBy: "user-editor-1",
    updatedBy: "user-editor-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}
