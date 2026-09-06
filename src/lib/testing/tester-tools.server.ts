import "server-only";

import type { ToolDefinition } from "@/lib/copilot/index.server";
import type { TesterToolContext } from "./types";
import { buildListTestSuitesTool } from "./tools/list-test-suites";
import { buildGetTestSuiteDetailsTool } from "./tools/get-test-suite-details";
import { buildGetTestCaseDetailsTool } from "./tools/get-test-case-details";
import { buildCreateTestCasesTool } from "./tools/create-test-cases";
import { buildCreateTestSuiteTool } from "./tools/create-test-suite";
import { buildUpdateTestCaseTool } from "./tools/update-test-case";
// Temporarily disabled (F8 decision): test-case deletion is a human-only
// operation performed in the UI. The tool implementation is kept intact;
// re-enable by uncommenting both the import and the mount entry below.
// import { buildDeleteTestCaseTool } from "./tools/delete-test-case";
import { buildRunTestCaseTool } from "./tools/run-test-case";
import { buildRunTestSuiteTool } from "./tools/run-test-suite";
import { buildGetTestResultsTool } from "./tools/get-test-results";
import { buildGetMcpToolSchemaTool } from "./tools/get-mcp-tool-schema";
import { buildGetAgentSpecTool } from "./tools/get-agent-spec";
import { buildGetAssertionSchemaTool } from "./tools/get-assertion-schema";

/**
 * Builds the server-side tools injected into agents with role = 'tester'.
 * Provides full-lifecycle test automation capabilities:
 * discovery, case management, execution, and diagnostics.
 * Note: deletion tools are temporarily not mounted — deletion stays a
 * human-only operation in the UI (see comment above).
 */
export function buildTesterTools(ctx: TesterToolContext): ToolDefinition[] {
  // SECURITY (defense-in-depth): tester agents are invisible to
  // non-editors and dispatch paths filter them out — this assertion makes
  // tool mounting fail-closed even if a future dispatch path forgets that.
  if (!ctx.isEditor && !ctx.isAdmin) {
    return [];
  }
  return [
    buildListTestSuitesTool(ctx),
    buildGetTestSuiteDetailsTool(ctx),
    buildGetTestCaseDetailsTool(ctx),
    buildGetMcpToolSchemaTool(ctx),
    buildGetAgentSpecTool(ctx),
    buildGetAssertionSchemaTool(ctx),
    buildCreateTestSuiteTool(ctx),
    buildCreateTestCasesTool(ctx),
    buildUpdateTestCaseTool(ctx),
    // Temporarily disabled (F8 decision) — deletion is human-only in the UI:
    // buildDeleteTestCaseTool(ctx),
    buildRunTestCaseTool(ctx),
    buildRunTestSuiteTool(ctx),
    buildGetTestResultsTool(ctx),
  ];
}
