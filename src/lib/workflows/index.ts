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
  CanonicalChartNodeSchema,
  CanonicalCodeNodeSchema,
  CanonicalNodeSchema,
  CanonicalSqlNodeSchema,
  CanonicalToolNodeSchema,
  CanonicalWorkflowSpecSchema,
  ExecutionConfigSchema,
  LLMAgentNodeSchema,
  LLMChartNodeSchema,
  LLMCodeNodeSchema,
  LLMNodeSchema,
  LLMSqlNodeSchema,
  LLMToolNodeSchema,
  LLMWorkflowSpecSchema,
  RetriesSchema,
  type CanonicalAgentNode,
  type CanonicalChartNode,
  type CanonicalCodeNode,
  type CanonicalNode,
  type CanonicalSqlNode,
  type CanonicalToolNode,
  type CanonicalWorkflowSpec,
  type CodeLanguage,
  type ExecutionConfig,
  type LLMAgentNode,
  type LLMChartNode,
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

// Engine internals (execution-context, scheduler, per-node executors,
// in-process engine, cache) are intentionally NOT re-exported from
// this barrel. External consumers that need them (execute-workflow.ts,
// tests) import directly from the subpath modules. This keeps the
// public surface narrow and discourages bypassing the engine boundary.

export {
  buildWorkflowSpecFromRunEvents,
  type BuildFromEventsInput,
  type BuildFromEventsOutput,
  type SaveLineageReport,
  type ToolInvocation,
} from "./build-from-events";
