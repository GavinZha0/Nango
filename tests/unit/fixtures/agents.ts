/**
 * Shared test fixtures and factory helpers for Builtin Agents and AgentSpec.
 */

import type { AgentSpec } from "@/lib/builtin-agents/agent-spec";
import type { BuiltinAgentEntity } from "@/lib/db/schema";

let agentSeq = 1;

function makeSeqUuid(prefix: string, seq: number): string {
  const hex = seq.toString(16).padStart(12, "0");
  return `${prefix}-0000-4000-8000-${hex}`;
}

/**
 * Creates a valid AgentSpec projection used by runtime and dispatch.
 */
export function createMockAgentSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  const seq = agentSeq++;
  return {
    agentId: overrides.agentId ?? makeSeqUuid("01918a3a", seq),
    name: `Test Agent ${seq}`,
    role: null,
    modelProvider: "openai",
    model: "gpt-4o",
    prompt: "You are a helpful assistant.",
    temperature: null,
    maxTokens: null,
    toolApprovalMode: "never",
    sharedStateEnabled: false,
    maxSteps: 5,
    apiKey: "sk-mock-key",
    restUrl: null,
    tools: [],
    ...overrides,
  };
}

/**
 * Creates a valid BuiltinAgentEntity database record with sensible defaults.
 */
export function createMockBuiltinAgent(
  overrides: Partial<BuiltinAgentEntity> = {},
): BuiltinAgentEntity {
  const seq = agentSeq++;
  return {
    id: overrides.id ?? makeSeqUuid("01918a3b", seq),
    name: `Builtin Agent ${seq}`,
    description: `Description for agent ${seq}`,
    role: null,
    icon: null,
    modelProvider: "openai",
    model: "gpt-4o",
    prompt: "You are a helpful assistant.",
    temperature: null,
    maxTokens: null,
    maxSteps: 5,
    toolApprovalMode: "never",
    memoryEnabled: false,
    memoryWindowSize: null,
    enabled: true,
    sharedStateEnabled: false,
    visibility: "private",
    credentialId: overrides.credentialId ?? makeSeqUuid("01918a3c", seq),
    createdBy: "user-editor-1",
    updatedBy: "user-editor-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}
