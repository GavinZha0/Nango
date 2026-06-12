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
  type ChartRenderer,
  type CodeLanguage,
  type LLMAgentNode,
  type LLMChartNode,
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
   * nested at `inputs.inputs`.
   */
  inputs: Record<string, unknown>;
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
   * The artifact-creator tool's raw args — kept as-is so the save
   * orchestrator can derive metadata (`name`, `description`) and
   * downstream callers can inspect the original payload for
   * forensic / debugging purposes. NOT used to compute the
   * artifact's renderable body — that happens at view time via
   * `bundle.data`.
   */
  strippedFrontendConfig: Record<string, unknown>;
  /** Tool name of the artifact creator (`generate_echarts_config`,
   *  `render_html`, …). */
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
 * `input.agent` and the agent's input at `input.inputs` (per the
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

/**
 * Pattern matching every chart-producing server tool. The chart
 * library is encoded in the tool-name suffix: `generate_<lib>_config`
 * (today only `generate_echarts_config` ships; future
 * `generate_plotly_config` / `generate_vega_config` plug in by
 * registering a new entry here).
 *
 * The save pipeline rewrites a captured chart tool invocation to a
 * `type: "chart"` workflow node with `inputs.renderer = <lib>`.
 */
const CHART_TOOL_NAME_PATTERN = /^generate_([a-z][a-z0-9]*)_config$/;

/**
 * The set of chart renderer libraries the save pipeline knows how
 * to bind. New entries here MUST also extend
 * `ChartRendererSchema` in `spec/schema.ts`.
 */
const SUPPORTED_CHART_RENDERERS = new Set<ChartRenderer>(["echarts"]);

/**
 * Derive the chart node's `inputs.renderer` from a captured tool
 * name. Returns `null` when the name is not a chart tool or names
 * a renderer the spec schema does not recognise.
 */
function chartRendererFromToolName(toolName: string): ChartRenderer | null {
  const match = CHART_TOOL_NAME_PATTERN.exec(toolName);
  if (match === null) return null;
  const candidate = match[1] as ChartRenderer;
  return SUPPORTED_CHART_RENDERERS.has(candidate) ? candidate : null;
}

/** True when this invocation should become a `type: "chart"` node. */
function isChartInvocation(inv: ToolInvocation): boolean {
  return chartRendererFromToolName(inv.toolName) !== null;
}

/**
 * SQL extraction tool's operational fields — present on tool
 * results but not part of any spec node's output contract. Strategy
 * Z+ skips them so a literal `@nodes.X.cache_hit` never sneaks
 * into a downstream ref.
 *
 * Tool result fields the LLM might `@`-reference (`dataset_name`,
 * `total_rows`, `returned_rows`, `rows`, `row_schema`) ARE indexed
 * verbatim — the tool returns spec-shape directly so no
 * per-field projection is needed.
 */
const SQL_TOOL_OPERATIONAL_FIELDS = new Set<string>([
  "cache_hit",
  "ttl_hours",
  "replaced_prior",
]);

/**
 * Decide whether an upstream invocation's captured RESULT field
 * should enter the Strategy Z+ index. Returns the field name to
 * index on (always identical to `eventField` post-rename), or
 * `null` to skip operational metadata.
 */
function indexableResultFieldName(
  inv: ToolInvocation,
  eventField: string,
): string | null {
  if (inv.toolName === SQL_EXTRACTION_TOOL) {
    if (SQL_TOOL_OPERATIONAL_FIELDS.has(eventField)) return null;
  }
  return eventField;
}

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

  // strippedFrontendConfig carries the artifact creator's raw args.
  // The save orchestrator reads it to derive artifact display metadata
  // (name, description). The former `artifact.content` column that
  // stored this payload was dropped (migration 0004).
  const strippedFrontendConfig = { ...artifactCreator.inputs };

  // Chart tools (generate_echarts_config / generate_<lib>_config)
  // become first-class workflow nodes — their invocations stay in
  // `dataInvocations`. Every other artifact creator (render_html,
  // render_markdown, …) produces final rendered output rather than
  // a replayable data operation and is stripped from the pipeline.
  const artifactCreatorIsChart = isChartInvocation(artifactCreator);
  const dataInvocations = artifactCreatorIsChart
    ? successful
    : successful.filter((i) => i.callId !== artifactCreatingCallId);

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
  //
  // Special-case: when the artifact creator is a chart tool, the
  // spec's output is the chart node's merged option — there is no
  // freeform args-to-outputs mapping. We pin spec.outputs to
  // `{ option: "@nodes.<chartNodeId>.option" }`.
  const outputs = artifactCreatorIsChart
    ? buildChartOutputsMap(dataInvocations, reconciled.nodes, artifactCreatingCallId)
    : buildOutputsMap(
        reconciled.rewrittenArtifactInput,
        reconciled.nodes,
        dataInvocations,
      );

  const spec: LLMWorkflowSpec = {
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
  if (isChartInvocation(invocation)) {
    return assembleChartNode(invocation, id);
  }
  return assembleToolNode(invocation, id);
}

function assembleToolNode(invocation: ToolInvocation, id: number): LLMToolNode {
  return {
    id,
    type: "tool",
    description: deriveDescription(invocation),
    depends_on: [],
    inputs: {
      name: invocation.toolName,
      arguments: invocation.inputs,
    },
  };
}

function assembleAgentNode(
  invocation: ToolInvocation,
  id: number,
): LLMAgentNode {
  const agentDisplay = readStringField(invocation.inputs, "agent");
  if (agentDisplay === undefined) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: agent invocation ${invocation.callId} has no 'agent' field in input.`,
    );
  }
  // `delegate_to_agent` carries `task` as a top-level arg.
  const task = readStringField(invocation.inputs, "task");
  if (task === undefined || task.length === 0) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: agent invocation ${invocation.callId} has no 'task' field in input.`,
    );
  }
  const context = readStringField(invocation.inputs, "context");
  const inputs: LLMAgentNode["inputs"] = { name: agentDisplay, task };
  if (context !== undefined && context.length > 0) {
    inputs.context = context;
  }
  return {
    id,
    type: "agent",
    description: deriveDescription(invocation),
    depends_on: [],
    inputs,
  };
}

/**
 * Build a `type: "code"` LLM-emit node from a captured
 * `run_code_in_sandbox` invocation.
 *
 * Wire mapping:
 *   - `args.code_text`       → `inputs.code_text`
 *   - `args.language`        → `inputs.language`
 *   - `args.datasets`        → `inputs.datasets`
 *   - `args.params`          → `inputs.params`
 *   - `args.timeout_seconds` → `timeout_seconds` (lifted to base)
 */
function assembleCodeNode(
  invocation: ToolInvocation,
  id: number,
): LLMCodeNode {
  const codeText = readStringField(invocation.inputs, "code_text");
  if (codeText === undefined || codeText.length === 0) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: code invocation ${invocation.callId} has no 'code_text' field.`,
    );
  }
  const language = inferCodeLanguage(invocation.inputs);
  const inputs: LLMCodeNode["inputs"] = {
    language,
    code_text: codeText,
  };
  // Datasets pass through unchanged — Strategy Z+ rewrites
  // matching elements into `@nodes.X.dataset_name` refs later.
  const datasets = invocation.inputs.datasets;
  if (Array.isArray(datasets) && datasets.length > 0) {
    inputs.datasets = datasets;
  }
  const params = readObjectField(invocation.inputs, "params");
  if (params !== undefined && Object.keys(params).length > 0) {
    inputs.params = params;
  }
  const node: LLMCodeNode = {
    id,
    type: "code",
    description: deriveDescription(invocation),
    depends_on: [],
    inputs,
  };
  const t = readNumberField(invocation.inputs, "timeout_seconds");
  if (t !== undefined) node.timeout_seconds = t;
  return node;
}

/**
 * Build a `type: "sql"` LLM-emit node from a captured
 * `extract_dataset_by_sql` invocation.
 *
 * Wire mapping:
 *   - `args.data_source_name`  → `inputs.data_source_name`
 *   - `args.sql_text`          → `inputs.sql_text`
 *   - `args.dataset_name`      → `inputs.dataset_name` (optional)
 *   - `args.row_limit`         → DROPPED (engine-side policy)
 *   - `args.force_refresh`     → DROPPED (artifact-level concern)
 */
function assembleSqlNode(invocation: ToolInvocation, id: number): LLMSqlNode {
  const dataSourceName = readStringField(invocation.inputs, "data_source_name");
  const sqlText = readStringField(invocation.inputs, "sql_text");
  if (dataSourceName === undefined || dataSourceName.length === 0) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: sql invocation ${invocation.callId} has no 'data_source_name' field.`,
    );
  }
  if (sqlText === undefined || sqlText.length === 0) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: sql invocation ${invocation.callId} has no 'sql_text' field.`,
    );
  }
  const inputs: LLMSqlNode["inputs"] = {
    data_source_name: dataSourceName,
    sql_text: sqlText,
  };
  const datasetName = readStringField(invocation.inputs, "dataset_name");
  if (datasetName !== undefined && datasetName.length > 0) {
    inputs.dataset_name = datasetName;
  }
  return {
    id,
    type: "sql",
    description: deriveDescription(invocation),
    depends_on: [],
    inputs,
  };
}

/**
 * Build a `type: "chart"` LLM-emit node from a captured chart-tool
 * invocation (today: `generate_echarts_config`; future:
 * `generate_plotly_config` / `generate_vega_config`, …).
 *
 * Wire mapping:
 *   - tool name suffix    → `inputs.renderer` (echarts / plotly / …)
 *   - `inputs.option`     → `inputs.config` (verbatim — Strategy Z+
 *                           later strips `dataset.source` when it
 *                           successfully rewrites it to a ref)
 *   - `inputs.dataset`    starts UNSET. The ref reconstruction step
 *                         populates it when an upstream node's array
 *                         output matches the option's data; otherwise
 *                         the chart is saved as not-refreshable
 *                         (literal data baked into `config`).
 *
 * Other captured args (`chart_id`, `title`, `description`,
 * `dataset_id`) are intentionally NOT carried onto the chart node —
 * they live on `artifact.content` and never feed workflow execution.
 */
function assembleChartNode(
  invocation: ToolInvocation,
  id: number,
): LLMChartNode {
  const renderer = chartRendererFromToolName(invocation.toolName);
  if (renderer === null) {
    // The dispatcher checks `isChartInvocation` first; reaching here
    // is a programmer error in this module.
    throw new Error(
      `buildWorkflowSpecFromRunEvents: chart invocation ${invocation.callId} has unsupported tool '${invocation.toolName}'.`,
    );
  }
  const option = readObjectField(invocation.inputs, "option");
  if (option === undefined) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: chart invocation ${invocation.callId} has no 'option' object field.`,
    );
  }
  // Deep-clone so downstream ref rewriting can mutate freely
  // without surprising the caller's invocation list.
  const config = structuredClone(option) as Record<string, unknown>;
  return {
    id,
    type: "chart",
    description: deriveDescription(invocation),
    depends_on: [],
    inputs: {
      renderer,
      config,
      // `dataset` left unset — Strategy Z+ fills it when a unique
      // upstream array match exists.
    },
  };
}

/**
 * Pick the language enum for an assembled code node from `args.language`.
 * Any unrecognised value falls through to `"python"` — the engine's
 * language→runtime table is narrow and the spec is the single source
 * of truth.
 */
function inferCodeLanguage(input: Record<string, unknown>): CodeLanguage {
  const direct = input.language;
  if (typeof direct === "string" && direct === "javascript") return "javascript";
  if (typeof direct === "string" && direct === "python") return "python";
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
  const sample = describeInputSnippet(invocation.inputs);
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
 *
 * Chart nodes get a separate matcher (`reconcileChartNode`) that
 * compares the captured option's `dataset.source` array against
 * upstream array-valued result fields. Match → produce a
 * `@path` ref + strip `dataset.source` from `config`. Miss →
 * leave the literal data in `config` and omit `inputs.dataset`
 * (the not-refreshable fallback).
 */
function reconstructRefs(input: ReconstructInput): ReconstructResult {
  const { nodes: literalNodes, dataInvocations, artifactInput } = input;
  const index: Map<string, SourceEntry[]> = new Map();
  const arrayIndex: Map<string, SourceEntry[]> = new Map();
  const lineage = newLineageAccumulator();
  const rewrittenNodes: LLMNode[] = [];

  for (let i = 0; i < literalNodes.length; i++) {
    const node = literalNodes[i]!;
    const invocation = dataInvocations[i]!;

    // SQL nodes don't get walked for literal-to-ref promotion by
    // Strategy Z+ (the LLM rarely literals into sql_text /
    // data_source_name / dataset_name). The addOutputsToIndex
    // call below still registers the captured tool's
    // `result.dataset_name` so downstream code nodes'
    // `inputs.datasets: [<name>]` get rewritten to
    // `@nodes.X.dataset_name`.
    if (node.type === "sql") {
      rewrittenNodes.push(node);
    } else if (node.type === "chart") {
      rewrittenNodes.push(reconcileChartNode(node, arrayIndex, lineage));
    } else {
      // Pick the ref-bearing input map per type:
      //   - tool:  `inputs.arguments` (the wrapper's args slot)
      //   - agent: `inputs` (flat parameter bag)
      //   - code:  `inputs ?? {}` (optional; restored by
      //             `withRewrittenInputAndDeps` on the way out)
      const inputMap = pickRefBearingInput(node);
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
      addOutputsToIndex(invocation, node.id, index);
      addArrayOutputsToIndex(invocation, node.id, arrayIndex);
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
 * Recursive arm of the input walker. Handles three cases:
 *
 *   Arrays  — recurse each element (same depth; arrays don't add
 *             object-nesting depth).
 *   Objects — recurse into their values ONE level deep (`depth === 0`
 *             only). Values at `depth === 1` that are themselves objects
 *             pass through unchanged — this prevents false positives
 *             from deeply nested structures. At `depth > 0` the
 *             candidate threshold tightens to 12 chars (vs 6 at top
 *             level) to filter common short string values (status codes,
 *             formatted dates, etc.) that might accidentally match an
 *             upstream output.
 *   Strings — candidate→index→rewrite treatment; non-candidates pass
 *             through.
 *
 * `deps` is mutated in place — callers initialise it once per node
 * and read it after the walk completes.
 */
function rewriteValueRecursive(args: {
  value: unknown;
  fieldPath: string;
  index: Map<string, SourceEntry[]>;
  consumingNodeId: number;
  lineage: SaveLineageReport;
  deps: Set<number>;
  /** Object nesting depth. 0 = top-level field, 1 = one object deep. */
  depth?: number;
}): unknown {
  const { value, fieldPath, index, consumingNodeId, lineage, deps, depth = 0 } = args;

  if (Array.isArray(value)) {
    // Pass current depth through — arrays don't add nesting depth.
    return value.map((elem, i) =>
      rewriteValueRecursive({
        value: elem,
        fieldPath: `${fieldPath}[${i}]`,
        index,
        consumingNodeId,
        lineage,
        deps,
        depth,
      }),
    );
  }

  // Recurse into plain objects one level deep (depth === 0 only).
  // Objects encountered at depth === 1 pass through unchanged.
  if (value !== null && typeof value === "object" && depth === 0) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = rewriteValueRecursive({
        value: v,
        fieldPath: `${fieldPath}.${k}`,
        index,
        consumingNodeId,
        lineage,
        deps,
        depth: 1,
      });
    }
    return result;
  }

  // Strings: apply depth-appropriate candidate check before the
  // index lookup. Top level uses the standard 6-char threshold;
  // inside nested objects use the stricter 12-char threshold.
  // Both guards return false for non-strings, so the type assertion
  // below is safe.
  if (typeof value !== "string") return value;
  const isCandidate =
    depth === 0 ? isRefCandidate(value) : isNestedRefCandidate(value);
  if (!isCandidate) return value;

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
  invocation: ToolInvocation,
  producingNodeId: number,
  index: Map<string, SourceEntry[]>,
): void {
  const result = invocation.result;
  if (result === null) return;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== "string") continue;
    if (!isRefCandidate(value)) continue;
    const fieldPath = indexableResultFieldName(invocation, key);
    if (fieldPath === null) continue;
    const entries = index.get(value);
    const entry: SourceEntry = { nodeId: producingNodeId, fieldPath };
    if (entries === undefined) {
      index.set(value, [entry]);
    } else {
      entries.push(entry);
    }
  }
}

/**
 * Stuffs every top-level ARRAY-valued field of an upstream
 * invocation's result into a separate index keyed by the canonical
 * JSON serialization of the array. The chart save matcher uses this
 * to recognise that the option's `dataset.source` came from a
 * specific upstream output (e.g. a SQL node's `rows` field, the
 * spec-side projection of the tool's `preview`).
 *
 * Empty arrays and arrays that serialize larger than
 * `ARRAY_INDEX_MAX_SERIALIZED_LEN` are skipped: empty matches are
 * spurious, and huge serialisations cost more than the match is
 * worth (and inflate the lineage report).
 */
function addArrayOutputsToIndex(
  invocation: ToolInvocation,
  producingNodeId: number,
  arrayIndex: Map<string, SourceEntry[]>,
): void {
  const result = invocation.result;
  if (result === null) return;
  for (const [key, value] of Object.entries(result)) {
    const serialized = canonicalArrayKey(value);
    if (serialized === null) continue;
    const fieldPath = indexableResultFieldName(invocation, key);
    if (fieldPath === null) continue;
    const entries = arrayIndex.get(serialized);
    const entry: SourceEntry = { nodeId: producingNodeId, fieldPath };
    if (entries === undefined) {
      arrayIndex.set(serialized, [entry]);
    } else {
      entries.push(entry);
    }
  }
}

/** Hard cap on indexed array serialization length. ~1 MB JSON. */
const ARRAY_INDEX_MAX_SERIALIZED_LEN = 1_000_000;

/**
 * Canonical JSON key for a candidate array — used as the
 * `arrayIndex` map key. Returns `null` for values that should NOT be
 * indexed (non-arrays, empty arrays, oversize serializations,
 * un-serializable values).
 */
function canonicalArrayKey(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  try {
    const s = JSON.stringify(value);
    if (s.length > ARRAY_INDEX_MAX_SERIALIZED_LEN) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Reconcile a chart node against the upstream array-output index.
 *
 * Single-dataset (config.dataset is an object):
 *   If `dataset.source` deep-equals a unique upstream array output →
 *   strip `source` from `config`, bind `inputs.dataset` to the ref.
 *
 * Multi-dataset (config.dataset is an array of ≥ 2 objects):
 *   Apply all-or-nothing matching: every element's `.source` must
 *   uniquely match an upstream output, otherwise fall back to
 *   not-refreshable. See `reconcileMultiDatasetChart` for details.
 *
 * Not-refreshable fallback: when no match is possible the chart is
 * returned unchanged — the engine passes `config` through verbatim
 * and the UI shows a "not refreshable" indicator.
 */
function reconcileChartNode(
  node: LLMChartNode,
  arrayIndex: Map<string, SourceEntry[]>,
  lineage: SaveLineageReport,
): LLMChartNode {
  // Only ECharts is recognised today; future renderers extend here.
  if (node.inputs.renderer !== "echarts") return node;

  const dataset = node.inputs.config.dataset;
  if (dataset === null || typeof dataset !== "object") return node;

  // ── Multi-dataset path ─────────────────────────────────────────
  if (Array.isArray(dataset)) {
    // Require at least 2 elements (ChartDatasetRefSchema.min(2)).
    // 1-element arrays are unusual — LLMs use the object form for
    // single datasets — and would produce an invalid ref array.
    if (dataset.length < 2) return node;
    return reconcileMultiDatasetChart(node, dataset, arrayIndex, lineage);
  }

  // ── Single-dataset path ────────────────────────────────────────
  const source = (dataset as Record<string, unknown>).source;
  const key = canonicalArrayKey(source);
  if (key === null) return node;

  const sources = arrayIndex.get(key) ?? [];
  if (sources.length === 0) {
    pushLineageCandidateNoMatch(lineage, node.id, "inputs.config.dataset.source",
      `<array length=${(source as unknown[]).length}>`);
    return node;
  }
  if (sources.length > 1) {
    pushLineageAmbiguousMatch(lineage, node.id, "inputs.config.dataset.source",
      `<array length=${(source as unknown[]).length}>`, sources);
    return node;
  }

  const match = sources[0]!;
  const ref = `@nodes.${match.nodeId}.${match.fieldPath}`;
  pushLineageResolvedRef(lineage, node.id, "inputs.config.dataset.source", ref);

  const strippedDataset = { ...(dataset as Record<string, unknown>) };
  delete strippedDataset.source;
  const strippedConfig = { ...node.inputs.config, dataset: strippedDataset };
  return {
    ...node,
    inputs: { ...node.inputs, config: strippedConfig, dataset: ref },
    depends_on: [match.nodeId],
  };
}

/**
 * All-or-nothing multi-dataset reconciliation.
 *
 * Walks each element of `config.dataset` (an ECharts dataset array)
 * and tries to match its `.source` against the upstream array-output
 * index. Every element must resolve to exactly one upstream output;
 * if any fail the entire chart falls back to not-refreshable.
 *
 * On success:
 *   - Strip `source` from each element (data lives in the upstream node)
 *   - Set `inputs.dataset: [ref0, ref1, …]` (array of @path refs)
 *   - Set `depends_on` to the sorted union of matched node ids
 *
 * The resulting spec passes the `ChartDatasetRefSchema` constraint
 * (array min(2)) because the caller already required dataset.length ≥ 2.
 */
function reconcileMultiDatasetChart(
  node: LLMChartNode,
  datasetArray: unknown[],
  arrayIndex: Map<string, SourceEntry[]>,
  lineage: SaveLineageReport,
): LLMChartNode {
  const refs: string[] = [];
  const matchedNodeIds = new Set<number>();
  const strippedElems: Array<Record<string, unknown>> = [];

  for (let i = 0; i < datasetArray.length; i++) {
    const elem = datasetArray[i];
    const field = `inputs.config.dataset[${i}].source`;

    if (elem === null || typeof elem !== "object" || Array.isArray(elem)) {
      pushLineageCandidateNoMatch(lineage, node.id, field, "<non-object element>");
      return node;
    }

    const source = (elem as Record<string, unknown>).source;
    const key = canonicalArrayKey(source);
    if (key === null) {
      pushLineageCandidateNoMatch(lineage, node.id, field, "<missing or empty source>");
      return node;
    }

    const sources = arrayIndex.get(key) ?? [];
    if (sources.length === 0) {
      pushLineageCandidateNoMatch(lineage, node.id, field,
        `<array length=${(source as unknown[]).length}>`);
      return node;
    }
    if (sources.length > 1) {
      pushLineageAmbiguousMatch(lineage, node.id, field,
        `<array length=${(source as unknown[]).length}>`, sources);
      return node;
    }

    const match = sources[0]!;
    refs.push(`@nodes.${match.nodeId}.${match.fieldPath}`);
    matchedNodeIds.add(match.nodeId);

    const stripped = { ...(elem as Record<string, unknown>) };
    delete stripped.source;
    strippedElems.push(stripped);
  }

  // All elements matched — record lineage and produce a refreshable chart.
  for (let i = 0; i < refs.length; i++) {
    pushLineageResolvedRef(lineage, node.id,
      `inputs.config.dataset[${i}].source`, refs[i]!);
  }

  const strippedConfig = { ...node.inputs.config, dataset: strippedElems };
  const sortedDeps = [...matchedNodeIds].sort((a, b) => a - b);
  return {
    ...node,
    inputs: { ...node.inputs, config: strippedConfig, dataset: refs },
    depends_on: sortedDeps,
  };
}

// ─── Lineage mutation helpers ──────────────────────────────────────────

function pushLineageResolvedRef(
  lineage: SaveLineageReport,
  nodeId: number,
  field: string,
  ref: string,
): void {
  (lineage.resolved_refs as Array<{
    nodeId: number; field: string; resolved_to: string; confidence: "unique-match";
  }>).push({ nodeId, field, resolved_to: ref, confidence: "unique-match" });
}

function pushLineageCandidateNoMatch(
  lineage: SaveLineageReport,
  nodeId: number,
  field: string,
  value: string,
): void {
  (lineage.candidate_values_no_match as Array<{
    nodeId: number; field: string; value: string;
  }>).push({ nodeId, field, value });
}

function pushLineageAmbiguousMatch(
  lineage: SaveLineageReport,
  nodeId: number,
  field: string,
  value: string,
  sources: SourceEntry[],
): void {
  (lineage.ambiguous_matches as Array<{
    nodeId: number; field: string; value: string;
    possible_sources: ReadonlyArray<{ nodeId: number; fieldPath: string }>;
  }>).push({ nodeId, field, value, possible_sources: sources.slice() });
}

/** Excludes the two node types that bypass `withRewrittenInputAndDeps`. */
type RefBearingNode = Exclude<LLMNode, LLMSqlNode | LLMChartNode>;

/**
 * Pick the (possibly nested) map of fields where `@path` refs may
 * appear for the given LLM-emit node.
 *
 * CONTRACT: only called for `tool`, `agent`, and `code` nodes.
 * SQL nodes are pushed through unchanged; chart nodes go through
 * `reconcileChartNode`. Both are excluded from the call site via the
 * `RefBearingNode` type, so this function never receives them.
 */
function pickRefBearingInput(node: RefBearingNode): Record<string, unknown> {
  if (node.type === "tool") return node.inputs.arguments;
  if (node.type === "agent") {
    const out: Record<string, unknown> = { task: node.inputs.task };
    if (node.inputs.context !== undefined) out.context = node.inputs.context;
    return out;
  }
  if (node.type === "code") {
    // `inputs.code_text` / `inputs.code_file` / `inputs.language`
    // are not ref-bearing — only `datasets` (Strategy Z+ array
    // recursion picks up dataset-name refs) and `params` (any
    // `@inputs.*` refs threaded into env values).
    const out: Record<string, unknown> = {};
    if (node.inputs.datasets !== undefined) out.datasets = node.inputs.datasets;
    if (node.inputs.params !== undefined) out.params = node.inputs.params;
    return out;
  }
  // TypeScript exhaustiveness: RefBearingNode = tool | agent | code.
  return assertNeverNode(node);
}

function withRewrittenInputAndDeps(
  node: RefBearingNode,
  rewrittenInput: Record<string, unknown>,
  depends_on: number[],
): RefBearingNode {
  // Tool nodes carry the rewritten map back into
  // `inputs.arguments` (the wrapper's args slot). `inputs.name`
  // is preserved from the original captured invocation.
  if (node.type === "tool") {
    return {
      ...node,
      inputs: { name: node.inputs.name, arguments: rewrittenInput },
      depends_on,
    };
  }
  // Agent nodes: `inputs.name` is the display string, never a
  // ref; `task` (required) and `context` (optional) are the
  // ref-bearing fields. The walker only touched those two — pull
  // them back out and rebuild the structured `inputs`.
  if (node.type === "agent") {
    const rewrittenTask = rewrittenInput.task;
    const task =
      typeof rewrittenTask === "string" && rewrittenTask.length > 0
        ? rewrittenTask
        : node.inputs.task;
    const rewrittenContext = rewrittenInput.context;
    const nextInputs: LLMAgentNode["inputs"] = {
      name: node.inputs.name,
      task,
    };
    if (typeof rewrittenContext === "string" && rewrittenContext.length > 0) {
      nextInputs.context = rewrittenContext;
    } else if (node.inputs.context !== undefined) {
      nextInputs.context = node.inputs.context;
    }
    return { ...node, inputs: nextInputs, depends_on };
  }
  // Code nodes: preserve `inputs.{language,code_text,code_file}`
  // verbatim and reapply the rewritten `datasets` / `params` only
  // when present.
  if (node.type === "code") {
    const nextInputs: LLMCodeNode["inputs"] = {
      language: node.inputs.language,
      ...(node.inputs.code_text !== undefined && {
        code_text: node.inputs.code_text,
      }),
      ...(node.inputs.code_file !== undefined && {
        code_file: node.inputs.code_file,
      }),
    };
    if (rewrittenInput.datasets !== undefined) {
      nextInputs.datasets = rewrittenInput.datasets as unknown[];
    } else if (node.inputs.datasets !== undefined) {
      nextInputs.datasets = node.inputs.datasets;
    }
    if (rewrittenInput.params !== undefined) {
      nextInputs.params = rewrittenInput.params as Record<string, unknown>;
    } else if (node.inputs.params !== undefined) {
      nextInputs.params = node.inputs.params;
    }
    return { ...node, inputs: nextInputs, depends_on };
  }
  // TypeScript exhaustiveness: RefBearingNode = tool | agent | code.
  return assertNeverNode(node);
}

function assertNeverNode(node: never): never {
  throw new Error(
    `build-from-events: unhandled RefBearingNode type ${JSON.stringify(node)}`,
  );
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

/**
 * Build `spec.outputs` for a chart-rooted artifact.
 *
 * INVARIANT: `nodes` and `dataInvocations` are parallel arrays —
 * `nodes[i]` was assembled from `dataInvocations[i]` in order and
 * the two arrays always have the same length. The chart node sits at
 * `idx`, the position of `artifactCreatingCallId` in
 * `dataInvocations`.
 *
 * If either lookup fails (chart call was ok=false and filtered out of
 * `dataInvocations`, or `assembleNode` produced the wrong type), we
 * throw immediately rather than returning a wrong sentinel that would
 * pass here but fail at validate time with a confusing error message.
 */
function buildChartOutputsMap(
  dataInvocations: ReadonlyArray<ToolInvocation>,
  nodes: ReadonlyArray<LLMNode>,
  artifactCreatingCallId: string,
): Record<string, string> {
  const idx = dataInvocations.findIndex(
    (inv) => inv.callId === artifactCreatingCallId,
  );
  if (idx < 0) {
    // The chart tool call was filtered from dataInvocations — most
    // likely because it completed with ok=false. A failed chart call
    // cannot be saved as a workflow.
    throw new Error(
      `buildChartOutputsMap: chart callId '${artifactCreatingCallId}' ` +
      `is not present in dataInvocations (was it a failed tool call?). ` +
      `Cannot build spec.outputs without a chart node.`,
    );
  }
  const chartNode = nodes[idx];
  if (chartNode === undefined || chartNode.type !== "chart") {
    // Programmer error: assembleNode should always produce a chart
    // node for a chart invocation. This path should be unreachable.
    throw new Error(
      `buildChartOutputsMap: expected a chart node at index ${idx} ` +
      `(callId '${artifactCreatingCallId}') but got ` +
      `${chartNode === undefined ? "undefined" : `type="${chartNode.type}"`}. ` +
      `This indicates a bug in the assembleNode dispatch table.`,
    );
  }
  return { option: `@nodes.${chartNode.id}.option` };
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
    inputs: {
      name: "noop",
      arguments: {},
    },
  };
}

// ─── Ref candidate guards ──────────────────────────────────────────────

/**
 * Stricter ref-candidate filter for string values inside **nested
 * objects** (depth > 0 in `rewriteValueRecursive`).
 *
 * Uses a 12-character floor instead of the standard 6-character
 * floor to reduce false positives from short field values that
 * commonly appear inside nested parameters:
 *   - Status codes / enums ("active", "pending", "monthly") — 6–9 chars
 *   - ISO dates ("2026-01-01") — 10 chars
 *
 * IDs and dataset names that should be matched (customer UUIDs,
 * slugs like "monthly_sales_q1") are typically 12+ chars.
 */
function isNestedRefCandidate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 12) return false;
  if (/\s/.test(value)) return false;
  return true;
}

// ─── Misc helpers ──────────────────────────────────────────────────────

function deriveWorkflowName(artifactCreator: ToolInvocation): string {
  const title =
    readStringField(artifactCreator.inputs, "title") ??
    readStringField(artifactCreator.inputs, "name") ??
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
