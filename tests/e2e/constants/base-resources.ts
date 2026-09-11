/**
 * Base resources seeded during setup for all E2E tests to consume.
 *
 * CONTRACT: These are read-only baselines. Tests may view, select,
 * and assert against them, but must NEVER edit, disable, or delete them.
 */

export const BASE_NAMES = {
  llmCredential: "Base-LLM-e2e-Credential",
  supervisorAgent: "Nango",
  generalAgent: "Base-General-e2e-Agent",
  evaluatorAgent: "Base-Judge-e2e-Agent",
  dailySchedule: "Base-Daily-e2e-Schedule",
  unreadNotification: "Base-Task-Completed-e2e-Notification",
  readNotification: "Base-Task-Failed-e2e-Notification",
  mcpServer: "Base-Mock-e2e-Mcp",
  datasourceCredential: "Base-Datasource-e2e-Credential",
  dataSource: "base-postgres-e2e-ds",
  sshCredential: "Base-SSH-e2e-Credential",
  sshServer: "base-mock-e2e-ssh",
} as const;

export const E2E_PLACEHOLDER_KEY = "sk-test-e2e-placeholder-key";
