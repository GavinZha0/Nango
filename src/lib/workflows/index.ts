/**
 * Public surface of the workflow subsystem. Importers outside
 * `src/lib/workflows/` should depend ONLY on what this barrel
 * re-exports — internal modules are subject to change without notice.
 *
 * See docs/workflow.md.
 */

export {
  WORKFLOW_SCOPED_ERROR_CODES,
  WorkflowError,
  toResult,
  type WorkflowErrorCode,
  type WorkflowErrorResult,
} from "./error";

export {
  CanonicalAgentNodeSchema,
  CanonicalCodeNodeSchema,
  CanonicalNodeSchema,
  CanonicalSqlNodeSchema,
  CanonicalToolNodeSchema,
  CanonicalWorkflowSpecSchema,
  DEFAULT_AGENT_OUTPUT_SCHEMA,
  DEFAULT_CODE_NODE_OUTPUTS,
  DEFAULT_SQL_NODE_OUTPUTS,
  ExecutionConfigSchema,
  LLMAgentNodeSchema,
  LLMCodeNodeSchema,
  LLMNodeSchema,
  LLMSqlNodeSchema,
  LLMToolNodeSchema,
  LLMWorkflowSpecSchema,
  RetriesSchema,
  type CanonicalAgentNode,
  type CanonicalCodeNode,
  type CanonicalNode,
  type CanonicalSqlNode,
  type CanonicalToolNode,
  type CanonicalWorkflowSpec,
  type CodeLanguage,
  type ExecutionConfig,
  type LLMAgentNode,
  type LLMCodeNode,
  type LLMNode,
  type LLMSqlNode,
  type LLMToolNode,
  type LLMWorkflowSpec,
  type NodeType,
  type Retries,
} from "./spec/schema";

export {
  findEmbeddedRefs,
  isRefCandidate,
  parseRef,
  serializeRef,
  type ContextRef,
  type NodeOutputRef,
  type WorkflowInputRef,
  type WorkflowRef,
} from "./spec/refs";

export {
  REF_RECON_ALGORITHM,
  canonicalize,
  type CanonicalizeDeps,
  type ToolMetadata,
} from "./spec/canonicalize";

export { validate } from "./spec/validate";

export { canonicalJson, hashJson } from "./spec/hash";

export type {
  AgentRunRequest,
  AgentRunResult,
  ExecuteParams,
  ToolHandle,
  WorkflowEngine,
  WorkflowEngineDependencies,
  WorkflowEngineEvent,
  WorkflowResult,
} from "./engine";

export {
  createExecutionState,
  resolveRefs,
  type ExecutionState,
} from "./engine/execution-context";

export {
  runScheduler,
  type NodeExecutor,
  type ScheduleParams,
} from "./engine/scheduler";

export {
  executeToolNode,
  type ToolNodeDeps,
} from "./nodes/tool-node";

export {
  executeAgentNode,
  type AgentNodeDeps,
} from "./nodes/agent-node";

export { inProcessWorkflowEngine } from "./engine/in-process";

export {
  InProcessLruCache,
  computeCacheKey,
  type WorkflowCache,
} from "./engine/cache";

export {
  buildWorkflowSpecFromRunEvents,
  type BuildFromEventsInput,
  type BuildFromEventsOutput,
  type SaveLineageReport,
  type ToolInvocation,
} from "./build-from-events";
