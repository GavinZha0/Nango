import "server-only";

import type { ToolDefinition } from "@/lib/copilot/index.server";
import type { TesterToolContext } from "./types";
import { buildListTestSuitesTool } from "./tools/list-test-suites";
import { buildGetTestSuiteDetailsTool } from "./tools/get-test-suite-details";
import { buildGetTestCaseDetailsTool } from "./tools/get-test-case-details";
import { buildCreateTestCasesTool } from "./tools/create-test-cases";
import { buildCreateTestSuiteTool } from "./tools/create-test-suite";
import { buildUpdateTestCaseTool } from "./tools/update-test-case";
import { buildDeleteTestCaseTool } from "./tools/delete-test-case";
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
 */
export function buildTesterTools(ctx: TesterToolContext): ToolDefinition[] {
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
    buildDeleteTestCaseTool(ctx),
    buildRunTestCaseTool(ctx),
    buildRunTestSuiteTool(ctx),
    buildGetTestResultsTool(ctx),
  ];
}
