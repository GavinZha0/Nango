/**
 * Save pipeline — pure function that maps captured tool invocations
 * into an LLM-emit workflow spec.
 *
 * Inputs: list of `ToolInvocation`s from the run's event log plus the
 * id of the artifact-creating call. Outputs: an `LLMWorkflowSpec`
 * (canonicalize + validate run NEXT), the artifact creator's raw
 * args (the artifact body), and a `SaveLineageReport` describing
 * what Strategy Z+ rewrote.
 *
 * See docs/workflow.md.
 */

import { isRefCandidate } from "./spec/refs";
import {
  DEFAULT_AGENT_OUTPUT_SCHEMA,
  type LLMAgentNode,
  type LLMCodeNode,
  type LLMNode,
  type LLMSqlNode,
  type LLMToolNode,
  type LLMWorkflowSpec,
} from "./spec/schema";

// ─── Public surface ────────────────────────────────────────────────────

/**
 * A coalesced tool/agent invocation from the entity_run_event log.
 * The runner-side adapter compresses the raw `tool_call_chunk` +
 * `tool_call_result` event pair into one `ToolInvocation` per call.
 *
 * Failed invocations (`ok: false`) are still included so the pipeline
 * can prune them out — keeps the input shape uniform.
 */
export interface ToolInvocation {
  /** Stable id from the AG-UI stream. */
  callId: string;
  /** Position in the event log — chronological order. */
  seq: number;
  /**
   * What was invoked. For agent calls, this is the `delegate_to_agent`
   * tool name; the agent identity lives in `input.agent`.
   */
  toolName: string;
  /**
   * Parsed input dict. For `delegate_to_agent`, the agent's input is
   * nested at `input.input`.
   */
  input: Record<string, unknown>;
  /** Parsed result dict on success; `null` on failure. */
  result: Record<string, unknown> | null;
  /** Whether the invocation completed successfully. */
  ok: boolean;
}

export interface BuildFromEventsInput {
  invocations: ReadonlyArray<ToolInvocation>;
  /** `callId` of the frontend_tool invocation that rendered the artifact. */
  artifactCreatingCallId: string;
}

export interface BuildFromEventsOutput {
  /** LLM-emit form — canonicalize / validate run NEXT. */
  spec: LLMWorkflowSpec;
  /**
   * The artifact-creator tool's raw args — kept as-is (not
   * pre-projected) so the save orchestrator can dispatch by tool
   * name to the right per-tool adapter
   * (`lib/outcomes/args-to-content.ts::chartArgsToContent` etc.).
   */
  strippedFrontendConfig: Record<string, unknown>;
  /** Tool name of the artifact creator (`render_chart`, `render_html`, …). */
  artifactCreatorToolName: string;
  /** Strategy Z+ telemetry — persisted as one `save_lineage_emitted` event. */
  lineageReport: SaveLineageReport;
}

/** Strategy Z+ telemetry — what the algorithm decided about each top-level input field. */
export interface SaveLineageReport {
  /** Fields that uniquely matched an upstream output → rewritten to a ref. */
  resolved_refs: ReadonlyArray<{
    nodeId: number;
    field: string;
    resolved_to: string;
    confidence: "unique-match";
  }>;
  /** Fields whose literal matched MULTIPLE upstream sources → kept literal. */
  ambiguous_matches: ReadonlyArray<{
    nodeId: number;
    field: string;
    value: string;
    possible_sources: ReadonlyArray<{ nodeId: number; fieldPath: string }>;
  }>;
  /**
   * Values that looked ID-shaped (passed `isRefCandidate`) but no
   * upstream produced them — typical for embedded IDs or values
   * originating from workflow inputs / context.
   */
  candidate_values_no_match: ReadonlyArray<{
    nodeId: number;
    field: string;
    value: string;
  }>;
  /** Long string values (≥ 50 chars) — future analysis target for embedded-id extraction. */
  embedded_suspects: ReadonlyArray<{
    nodeId: number;
    field: string;
    full_value: string;
  }>;
}

/**
 * The agent-delegation tool name. When `toolName` matches this, the
 * invocation is an agent node — the agent's display string lives at
 * `input.agent` and the agent's input at `input.input` (per the
 * supervisor's `delegate_to_agent` shape).
 */
const AGENT_DELEGATION_TOOL = "delegate_to_agent";

/**
 * The sandboxed-code-execution tool name. The save pipeline rewrites
 * the captured invocation to a `type: "code"` node. The tool itself
 * stays in the user catalog for chat use; the canonical workflow
 * spec never references it as a tool `name`.
 */
const CODE_EXECUTION_TOOL = "run_code_in_sandbox";

/**
 * The SQL-extraction tool name. The save pipeline rewrites the
 * captured invocation to a `type: "sql"` node. Like
 * CODE_EXECUTION_TOOL, the tool stays in the user catalog for chat
 * use only.
 */
const SQL_EXTRACTION_TOOL = "extract_dataset_by_sql";

// ─── Entry point ───────────────────────────────────────────────────────

/**
 * Build the LLM-emit workflow spec from a captured run's invocation
 * list. Pure — no DB, no I/O. Throws `Error` (NOT `WorkflowError` —
 * this is upstream of the workflow error boundary) when input
 * invariants are violated.
 */
export function buildWorkflowSpecFromRunEvents(
  input: BuildFromEventsInput,
): BuildFromEventsOutput {
  const { invocations, artifactCreatingCallId } = input;

  const artifactCreator = invocations.find(
    (i) => i.callId === artifactCreatingCallId,
  );
  if (artifactCreator === undefined) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: artifactCreatingCallId '${artifactCreatingCallId}' not found in invocation list.`,
    );
  }
  const sortedAsc = [...invocations].sort((a, b) => a.seq - b.seq);
  const upToArtifact = sortedAsc.slice(
    0,
    sortedAsc.findIndex((i) => i.callId === artifactCreatingCallId) + 1,
  );
  // Filter to successful invocations only. Failed calls produce no
  // usable output, can't be referenced by downstream nodes, and
  // would re-fail at refresh time — they must not become workflow
  // nodes. `i.ok` reflects the Nango tool envelope's success bit.
  const successful = upToArtifact.filter((i) => i.ok);

  // Strip the artifact creator — its input becomes
  // `strippedFrontendConfig` (→ artifact.content). Every OTHER call
  // in the successful chain becomes a workflow node.
  const strippedFrontendConfig = { ...artifactCreator.input };
  const dataInvocations = successful.filter(
    (i) => i.callId !== artifactCreatingCallId,
  );

  let nextId = 0;
  const literalNodes: LLMNode[] = dataInvocations.map((inv) => {
    const id = nextId++;
    return assembleNode(inv, id);
  });

  const reconciled = reconstructRefs({
    nodes: literalNodes,
    dataInvocations,
    artifactInput: strippedFrontendConfig,
  });

  // spec.outputs from the rewritten artifact-creator input. Only
  // entries Strategy Z+ successfully rewrote to a real @nodes ref
  // make it in — static literals (title, description, …) live in
  // `strippedFrontendConfig` and have no place in spec.outputs.
  const outputs = buildOutputsMap(
    reconciled.rewrittenArtifactInput,
    reconciled.nodes,
    dataInvocations,
  );

  const spec: LLMWorkflowSpec = {
    version: "1.0",
    name: deriveWorkflowName(artifactCreator),
    nodes: reconciled.nodes.length > 0
      ? reconciled.nodes
      : [placeholderNoOpNode()],
    outputs,
  };

  return {
    spec,
    strippedFrontendConfig,
    artifactCreatorToolName: artifactCreator.toolName,
    lineageReport: reconciled.lineageReport,
  };
}

// ─── Node assembly ─────────────────────────────────────────────────────

function assembleNode(invocation: ToolInvocation, id: number): LLMNode {
  if (invocation.toolName === AGENT_DELEGATION_TOOL) {
    return assembleAgentNode(invocation, id);
  }
  if (invocation.toolName === CODE_EXECUTION_TOOL) {
    return assembleCodeNode(invocation, id);
  }
  if (invocation.toolName === SQL_EXTRACTION_TOOL) {
    return assembleSqlNode(invocation, id);
  }
  return assembleToolNode(invocation, id);
}

function assembleToolNode(invocation: ToolInvocation, id: number): LLMToolNode {
  return {
    id,
    type: "tool",
    description: deriveDescription(invocation),
    depends_on: [],
    tool: invocation.toolName,
    input: invocation.input,
  };
}

function assembleAgentNode(
  invocation: ToolInvocation,
  id: number,
): LLMAgentNode {
  const agentDisplay = readStringField(invocation.input, "agent");
  const agentInput = readObjectField(invocation.input, "input");
  if (agentDisplay === undefined) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: agent invocation ${invocation.callId} has no 'agent' field in input.`,
    );
  }
  return {
    id,
    type: "agent",
    description: deriveDescription(invocation),
    depends_on: [],
    agent: agentDisplay,
    input: agentInput ?? {},
    // Runner wraps the agent's natural reply as `{ text: <reply> }`
    // at runtime; carry the matching default schema here.
    output_schema: { ...DEFAULT_AGENT_OUTPUT_SCHEMA },
  };
}

/**
 * Build a `type: "code"` LLM-emit node from a captured
 * `run_code_in_sandbox` invocation.
 *
 * Wire mapping:
 *   - `input.stdin`           → `code`
 *   - `input.command[0]`      → `language`
 *   - `input.datasets`        → `input.datasets` (verbatim;
 *                                Strategy Z+ array recursion rewrites
 *                                ref elements)
 *   - `input.timeoutSeconds`  → `timeoutSeconds` (lifted to base)
 *
 * The literal `command` + `stdin` keys are NOT preserved on the code
 * node's `input` — they're modeling artefacts of the sandbox tool's
 * call shape, replaced by first-class `language` + `code` fields.
 */
function assembleCodeNode(
  invocation: ToolInvocation,
  id: number,
): LLMCodeNode {
  const stdin = readStringField(invocation.input, "stdin");
  if (stdin === undefined || stdin.length === 0) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: code invocation ${invocation.callId} has no usable 'stdin' field.`,
    );
  }
  const language = inferCodeLanguage(invocation.input);
  // Preserve non-modelling keys (datasets, env, …); drop keys
  // promoted to first-class fields.
  const passthroughInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(invocation.input)) {
    if (k === "stdin" || k === "command") continue;
    if (k === "timeoutSeconds") continue;
    passthroughInput[k] = v;
  }
  const node: LLMCodeNode = {
    id,
    type: "code",
    description: deriveDescription(invocation),
    depends_on: [],
    language,
    code: stdin,
  };
  if (Object.keys(passthroughInput).length > 0) {
    node.input = passthroughInput;
  }
  const t = readNumberField(invocation.input, "timeoutSeconds");
  if (t !== undefined) node.timeoutSeconds = t;
  return node;
}

/**
 * Build a `type: "sql"` LLM-emit node from a captured
 * `extract_dataset_by_sql` invocation.
 *
 * Wire mapping:
 *   - `input.dataSourceName` → `dataSourceName`
 *   - `input.query`          → `query`
 *   - `input.name`           → `name` (output dataset slug)
 *   - `input.previewRows`    → DROPPED (chat affordance only;
 *                              engine pins to 0 at execute time)
 *   - `input.forceRefresh`   → DROPPED (refresh happens at the
 *                              artifact level)
 */
function assembleSqlNode(invocation: ToolInvocation, id: number): LLMSqlNode {
  const dataSourceName = readStringField(invocation.input, "dataSourceName");
  const query = readStringField(invocation.input, "query");
  if (dataSourceName === undefined || dataSourceName.length === 0) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: sql invocation ${invocation.callId} has no 'dataSourceName' field.`,
    );
  }
  if (query === undefined || query.length === 0) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: sql invocation ${invocation.callId} has no 'query' field.`,
    );
  }
  const node: LLMSqlNode = {
    id,
    type: "sql",
    description: deriveDescription(invocation),
    depends_on: [],
    dataSourceName,
    query,
  };
  const name = readStringField(invocation.input, "name");
  if (name !== undefined && name.length > 0) node.name = name;
  return node;
}

/**
 * Pick the language enum from the captured invocation's `command[0]`.
 * Recognises `python3` / `python` → `"python"`; any other prefix
 * also falls back to `"python"` — the engine's language→runtime table
 * is narrow and the spec is the single source of truth.
 */
function inferCodeLanguage(input: Record<string, unknown>): "python" {
  const command = input.command;
  if (Array.isArray(command) && command.length > 0) {
    const head = command[0];
    if (typeof head === "string") {
      if (head === "python3" || head === "python") return "python";
    }
  }
  return "python";
}

function readNumberField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function deriveDescription(invocation: ToolInvocation): string {
  const sample = describeInputSnippet(invocation.input);
  return sample.length > 0
    ? `${invocation.toolName} — ${sample}`
    : invocation.toolName;
}

function describeInputSnippet(input: Record<string, unknown>): string {
  // Pick the first one or two string/number-valued keys for a
  // human-readable suffix. Skip object/array values.
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (parts.length >= 2) break;
    if (typeof value === "string") {
      parts.push(`${key}=${truncate(value, 32)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(", ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// ─── Strategy Z+ ref reconstruction ────────────────────────────────────

interface ReconstructInput {
  nodes: ReadonlyArray<LLMNode>;
  dataInvocations: ReadonlyArray<ToolInvocation>;
  artifactInput: Record<string, unknown>;
}

interface ReconstructResult {
  /** Nodes with input scalars rewritten as @nodes refs and `depends_on` populated. */
  nodes: LLMNode[];
  /** Artifact-creator input with the same rewriting applied — used to derive spec.outputs. */
  rewrittenArtifactInput: Record<string, unknown>;
  lineageReport: SaveLineageReport;
}

/** Per-value entry in the value→source index. */
interface SourceEntry {
  nodeId: number;
  fieldPath: string;
}

/**
 * Strategy Z+ core. Walks nodes in chronological order: rewrites
 * each node's top-level input scalars using the *current* index
 * (only upstream nodes are visible); then adds the current node's
 * `result` top-level scalars to the index for downstream nodes.
 *
 * `depends_on` is derived from the set of upstream node ids
 * referenced by the rewritten input, sorted ascending for stable
 * output / cache key.
 */
function reconstructRefs(input: ReconstructInput): ReconstructResult {
  const { nodes: literalNodes, dataInvocations, artifactInput } = input;
  const index: Map<string, SourceEntry[]> = new Map();
  const lineage = newLineageAccumulator();
  const rewrittenNodes: LLMNode[] = [];

  for (let i = 0; i < literalNodes.length; i++) {
    const node = literalNodes[i]!;
    const invocation = dataInvocations[i]!;

    // SQL nodes have no generic `input` field — their refs would
    // live in `query` / `dataSourceName` / `name`, none of which
    // Strategy Z+ rewrites in V1 capture. Pass through unchanged;
    // the addOutputsToIndex call below still registers the SQL
    // node's `result.name` so downstream code nodes'
    // `datasets: [<name>]` get rewritten to `@nodes.X.name`.
    if (node.type === "sql") {
      rewrittenNodes.push(node);
    } else {
      // Code nodes' `input` is optional. Treat absent input as
      // empty record for the walker; `withRewrittenInputAndDeps`
      // restores the optional shape on the way out.
      const inputMap = node.input ?? {};
      const { rewrittenInput, deps } = rewriteInputViaIndex(
        inputMap,
        index,
        node.id,
        lineage,
      );
      rewrittenNodes.push(
        withRewrittenInputAndDeps(node, rewrittenInput, sortedDeps(deps)),
      );
    }

    if (invocation.result !== null) {
      addOutputsToIndex(invocation.result, node.id, index);
    }
  }

  // Apply the same rewriting to the artifact-creator input — its
  // rewritten values feed spec.outputs derivation. Use nodeId -1 in
  // lineage so admin forensics can distinguish artifact-input
  // rewrites from node rewrites.
  const { rewrittenInput: rewrittenArtifactInput } = rewriteInputViaIndex(
    artifactInput,
    index,
    -1,
    lineage,
  );

  return {
    nodes: rewrittenNodes,
    rewrittenArtifactInput,
    lineageReport: lineage,
  };
}

/**
 * Walk a node's `input` (record of top-level fields) and rewrite
 * matching scalar values to `@nodes.X.field` refs against the
 * value→source `index`. Returns the rewritten record plus the set
 * of upstream node ids that became dependencies.
 *
 * Array-aware: when a top-level field is an array, each element is
 * inspected individually and the array is rewritten element-by-
 * element. The dominant case is
 * `run_code_in_sandbox.datasets: [name]`, where the dataset handle
 * from `extract_dataset_by_sql.result.name` needs to flow into the
 * sandbox call.
 *
 * Lineage entries for array elements use `field[i]` notation in the
 * `field` slot. The spec itself only stores the rewritten array —
 * `field[i]` notation is NOT part of the spec's ref language.
 *
 * Nested object recursion is out of scope.
 */
function rewriteInputViaIndex(
  literalInput: Record<string, unknown>,
  index: Map<string, SourceEntry[]>,
  consumingNodeId: number,
  lineage: SaveLineageReport,
): { rewrittenInput: Record<string, unknown>; deps: Set<number> } {
  const rewrittenInput: Record<string, unknown> = {};
  const deps = new Set<number>();
  for (const [field, value] of Object.entries(literalInput)) {
    // Collect embedded-suspect signal at the top-level scalar boundary.
    if (typeof value === "string" && value.length >= 50) {
      (lineage.embedded_suspects as Array<{
        nodeId: number;
        field: string;
        full_value: string;
      }>).push({ nodeId: consumingNodeId, field, full_value: value });
    }
    rewrittenInput[field] = rewriteValueRecursive({
      value,
      fieldPath: field,
      index,
      consumingNodeId,
      lineage,
      deps,
    });
  }
  return { rewrittenInput, deps };
}

/**
 * Recursive arm of the input walker. Strings get the
 * candidate→index→rewrite treatment; arrays recurse into each
 * element; everything else passes through. `deps` is mutated in
 * place — callers initialise it once per node and read it after the
 * walk completes.
 */
function rewriteValueRecursive(args: {
  value: unknown;
  fieldPath: string;
  index: Map<string, SourceEntry[]>;
  consumingNodeId: number;
  lineage: SaveLineageReport;
  deps: Set<number>;
}): unknown {
  const { value, fieldPath, index, consumingNodeId, lineage, deps } = args;

  if (Array.isArray(value)) {
    return value.map((elem, i) =>
      rewriteValueRecursive({
        value: elem,
        fieldPath: `${fieldPath}[${i}]`,
        index,
        consumingNodeId,
        lineage,
        deps,
      }),
    );
  }

  if (typeof value !== "string" || !isRefCandidate(value)) {
    return value;
  }

  const sources = index.get(value) ?? [];
  if (sources.length === 1) {
    const source = sources[0]!;
    const ref = `@nodes.${source.nodeId}.${source.fieldPath}`;
    deps.add(source.nodeId);
    (lineage.resolved_refs as Array<{
      nodeId: number;
      field: string;
      resolved_to: string;
      confidence: "unique-match";
    }>).push({
      nodeId: consumingNodeId,
      field: fieldPath,
      resolved_to: ref,
      confidence: "unique-match",
    });
    return ref;
  }
  if (sources.length > 1) {
    (lineage.ambiguous_matches as Array<{
      nodeId: number;
      field: string;
      value: string;
      possible_sources: ReadonlyArray<{ nodeId: number; fieldPath: string }>;
    }>).push({
      nodeId: consumingNodeId,
      field: fieldPath,
      value,
      possible_sources: sources.slice(),
    });
    return value;
  }
  (lineage.candidate_values_no_match as Array<{
    nodeId: number;
    field: string;
    value: string;
  }>).push({ nodeId: consumingNodeId, field: fieldPath, value });
  return value;
}

function addOutputsToIndex(
  result: Record<string, unknown>,
  producingNodeId: number,
  index: Map<string, SourceEntry[]>,
): void {
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== "string") continue;
    if (!isRefCandidate(value)) continue;
    const entries = index.get(value);
    const entry: SourceEntry = { nodeId: producingNodeId, fieldPath: key };
    if (entries === undefined) {
      index.set(value, [entry]);
    } else {
      entries.push(entry);
    }
  }
}

function withRewrittenInputAndDeps(
  node: LLMNode,
  rewrittenInput: Record<string, unknown>,
  depends_on: number[],
): LLMNode {
  // SQL nodes have NO `input` field — their refs live in the
  // first-class `query` / `dataSourceName` / `name` slots, not a
  // generic input map. Writing `input: {}` onto a SQL node would
  // corrupt the schema.
  if (node.type === "sql") {
    return { ...node, depends_on };
  }
  // Code nodes' `input` is optional. If the original node had no
  // input AND no rewriting produced any keys, omit `input` to keep
  // the canonical spec minimal.
  if (
    node.type === "code" &&
    node.input === undefined &&
    Object.keys(rewrittenInput).length === 0
  ) {
    return { ...node, depends_on };
  }
  return { ...node, input: rewrittenInput, depends_on };
}

function sortedDeps(deps: Set<number>): number[] {
  return [...deps].sort((a, b) => a - b);
}

function newLineageAccumulator(): SaveLineageReport {
  return {
    resolved_refs: [],
    ambiguous_matches: [],
    candidate_values_no_match: [],
    embedded_suspects: [],
  };
}

// ─── spec.outputs ──────────────────────────────────────────────────────

function buildOutputsMap(
  rewrittenArtifactInput: Record<string, unknown>,
  nodes: ReadonlyArray<LLMNode>,
  dataInvocations: ReadonlyArray<ToolInvocation>,
): Record<string, string> {
  // Harvest the keys Strategy Z+ actually rewrote to refs — the
  // only artifact-creator inputs that came from upstream node
  // outputs and therefore deserve a place in spec.outputs.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rewrittenArtifactInput)) {
    if (typeof value === "string" && value.startsWith("@nodes.")) {
      out[key] = value;
    }
  }
  if (Object.keys(out).length > 0) return out;

  // No refs at all — the LLM-emit schema requires `outputs` to be
  // non-empty, so pick a sensible sentinel pointing at the LAST
  // data node's FIRST observed result field. Observed (not guessed)
  // so canonicalize + validate succeed.
  if (nodes.length === 0) {
    // Degenerate — no data nodes captured. Pipeline emitted a
    // placeholder no-op node (id 0); reference that.
    return { result: "@nodes.0.result" };
  }
  const lastNode = nodes[nodes.length - 1]!;
  const lastInvocation = dataInvocations[dataInvocations.length - 1];
  const observedKey = pickFirstObservedResultKey(lastInvocation);
  return { result: `@nodes.${lastNode.id}.${observedKey ?? "result"}` };
}

/**
 * Pick the first top-level key in the invocation's observed `result`.
 * Returns undefined when the tool returned no result; caller
 * substitutes a literal `result` fallback.
 */
function pickFirstObservedResultKey(
  invocation: ToolInvocation | undefined,
): string | undefined {
  if (invocation === undefined || invocation.result === null) return undefined;
  const keys = Object.keys(invocation.result);
  return keys.length > 0 ? keys[0] : undefined;
}

function placeholderNoOpNode(): LLMToolNode {
  // Degenerate spec — frontend_tool called with no data deps. The
  // LLM-emit schema requires nodes.length ≥ 1, so emit a single
  // no-op tool node. Refine via a fresh save from a richer chat.
  return {
    id: 0,
    type: "tool",
    description: "(no upstream data) — placeholder; save again from a richer chat to refine",
    depends_on: [],
    tool: "noop",
    input: {},
  };
}

// ─── Misc helpers ──────────────────────────────────────────────────────

function deriveWorkflowName(artifactCreator: ToolInvocation): string {
  const title =
    readStringField(artifactCreator.input, "title") ??
    readStringField(artifactCreator.input, "name") ??
    `Workflow from ${artifactCreator.toolName}`;
  return truncate(title, 80);
}

function readStringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function readObjectField(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = obj[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}
