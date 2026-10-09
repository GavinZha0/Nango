/**
 * Base resources seeded during setup for all E2E tests to consume.
 *
 * CONTRACT: These are read-only baselines. Tests may view, select,
 * and assert against them, but must NEVER edit, disable, or delete them.
 */

export const BASE_NAMES = {
  llmCredential: "Base-LLM-e2e-Credential",
  realLlmCredential: "Base-Real-LLM-e2e-Credential",
  supervisorAgent: "Nango",
  generalAgent: "Base-General-e2e-Agent",
  evaluatorAgent: "Base-Judge-e2e-Agent",
  realLlmAgent: "Base-Real-LLM-e2e-Agent",
  dailySchedule: "Base-Daily-e2e-Schedule",
  unreadNotification: "Base-Task-Completed-e2e-Notification",
  readNotification: "Base-Task-Failed-e2e-Notification",
  mcpServer: "Base-Mock-e2e-Mcp",
  datasourceCredential: "Base-Datasource-e2e-Credential",
  dataSource: "base-postgres-e2e-ds",
  sshCredential: "Base-SSH-e2e-Credential",
  sshServer: "base-mock-e2e-ssh",
  verificationSuite: "Base-Verification-e2e-Suite",
  verificationCase: "010_base_echo_case",
  evalSuite: "Base-Eval-e2e-Suite",
  evalCase: "010_base_eval_case",
  webAutoTarget: "Base-WebAuto-e2e-Target",
  webAutoSuite: "Base-WebAuto-e2e-Suite",
  webAutoCase: "010_base_webauto_case",
  traceThreadId: "0192a000-0000-7000-8000-000000000001",
  traceTask: "Base-e2e-Trace: Analyze quarterly financial data",
  realMsLearnMcpServer: "Base-Real-MsLearn-e2e-Mcp",
  realComplexMcpServer: "Base-Real-Complex-e2e-Mcp",
  realErrorMcpServer: "Base-Real-Error-e2e-Mcp",
  realVerificationSuite: "Base-Real-Verification-e2e-Suite",
  realVerificationCase: "010_mslearn_search_case",
} as const;

export const E2E_PLACEHOLDER_KEY = "sk-test-e2e-placeholder-key";

/**
 * Configurable parameters for real LLM integration in E2E tests.
 * Environment variables override default values to allow flexible provider and model switching.
 */
export const REAL_LLM_CONFIG = {
  provider: process.env.REAL_LLM_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "openai"),
  model: process.env.REAL_LLM_MODEL || "openai/gpt-oss-20b",
  apiKey: process.env.REAL_LLM_API_KEY || process.env.GROQ_API_KEY || "",
  baseUrl: process.env.REAL_LLM_BASE_URL,
} as const;

/**
 * Public, no-auth MCP server endpoints for live integration testing.
 */
export const REAL_MCP_CONFIG = {
  msLearnUrl: "https://learn.microsoft.com/api/mcp",
  context7Url: "https://mcp.context7.com/mcp",
  complexServerUrl: "https://mcpplaygroundonline.com/mcp-complex-server",
  errorServerUrl: "https://mcpplaygroundonline.com/mcp-error-server",
  statelessServerUrl: "https://mcpplaygroundonline.com/mcp-stateless-server",
} as const;
