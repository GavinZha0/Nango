/**
 * Save pipeline (Stage 1 capture) — pure function that maps
 * captured tool invocations into an LLM-emit workflow spec
 * (`docs/workflow-architecture.md` §10.1, §7.10.2).
 *
 * Complete §10.1.1 steps 2-9. Strategy Z+ ref reconstruction
 * (step 5) + lineage report (step 5/§7.10.5) wired in W1.5.B.
 *
 * Pipeline diagram:
 *
 *   ToolInvocation[]            ToolInvocation[]
 *      (raw)              →     (filtered, successful)
 *                                   │
 *                                   │  step 4: strip frontend_tool
 *                                   ▼
 *                              dataInvocations[]
 *                                   │
 *                                   │  step 7: bucket tag +
 *                                   │           numeric id +
 *                                   │           agent display string
 *                                   │  step 8: description
 *                                   ▼
 *                              LLMNode[] (literal inputs)
 *                                   │
 *                                   │  step 5: Strategy Z+
 *                                   │  - value→source index
 *                                   │  - rewrite literals → @nodes refs
 *                                   │  - derive depends_on
 *                                   │  - emit SaveLineageReport
 *                                   ▼
 *                              LLMNode[] + refs + depends_on
 *                                   │
 *                                   │  step 9: spec.outputs (refined)
 *                                   ▼
 *                              { spec, strippedFrontendConfig,
 *                                lineageReport }
 *
 * Step 6 (observed-shape `output_schema` for tool nodes via D19
 * source 3) is intentionally NOT performed here — the LLM-emit
 * tool node schema has no `output_schema` field; canonicalize
 * fills it from the registry (D19 source 1). Agent nodes carry
 * the D30 default `{text: string}` — observed-shape upgrade is a
 * V1.1+ refinement.
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
 * The runner-side adapter is responsible for compressing the raw
 * `tool_call_chunk` (incremental args) + `tool_call_result` event
 * pair into one `ToolInvocation` per call.
 *
 * Failed invocations (`ok: false`) are still included so the
 * pipeline can prune them out — keeps the input shape uniform.
 */
export interface ToolInvocation {
  /** Stable id from the AG-UI stream — used by Strategy Z+ to
   *  associate input refs with their producing nodes (W1.5.B). */
  callId: string;
  /** Position in the event log — chronological order. */
  seq: number;
  /** What was invoked. For agent calls, this is the
   *  `delegate_to_agent` tool name; the actual agent identity
   *  lives in `input.agent`. */
  toolName: string;
  /** Parsed input dict. For `delegate_to_agent`, the agent's
   *  input is nested at `input.input`. */
  input: Record<string, unknown>;
  /** Parsed result dict on success; `null` on failure. */
  result: Record<string, unknown> | null;
  /** Whether the invocation completed successfully. */
  ok: boolean;
}

export interface BuildFromEventsInput {
  invocations: ReadonlyArray<ToolInvocation>;
  /** The `callId` of the frontend_tool invocation that rendered the
   *  artifact (chart_renderer / render_html / render_markdown). */
  artifactCreatingCallId: string;
}

export interface BuildFromEventsOutput {
  /** LLM-emit form — canonicalize / validate run NEXT. */
  spec: LLMWorkflowSpec;
  /**
   * The artifact-creator tool's raw args. Used as the SOURCE for
   * the artifact's renderable content; the save orchestrator picks
   * the right per-tool adapter
   * (`lib/outcomes/args-to-content.ts::chartArgsToContent` for
   * `render_chart`, future adapters for `render_html` etc.) to
   * project these args into the block-model `{ blocks: [...] }`
   * shape the renderer expects.
   *
   * Kept as raw args (not pre-projected) so the save orchestrator
   * can dispatch by tool name without re-parsing the spec, and so
   * lineage / admin-forensics consumers see exactly what the LLM
   * emitted.
   */
  strippedFrontendConfig: Record<string, unknown>;
  /**
   * Tool name of the artifact creator (`render_chart`,
   * `render_html`, …). The save orchestrator uses this to pick
   * the right args → content adapter and to derive the artifact's
   * `type` (chart / html / report).
   */
  artifactCreatorToolName: string;
  /**
   * Strategy Z+ telemetry (§7.10.5). The orchestrator persists this
   * as one `save_lineage_emitted` event on the source entity_run.
   * Useful for admin forensics + V2 design data (Pattern D
   * frequency analysis lives in `embedded_suspects`).
   */
  lineageReport: SaveLineageReport;
}

/**
 * Strategy Z+ telemetry — what the algorithm decided about each
 * top-level input field across all captured nodes. Shape mirrors
 * `docs/workflow-architecture.md` §7.10.5.
 */
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
  /** Values that looked ID-shaped (passed `isRefCandidate`) but no
   *  upstream produced them — typical for Pattern D embedded IDs or
   *  values originating from workflow inputs / context. */
  candidate_values_no_match: ReadonlyArray<{
    nodeId: number;
    field: string;
    value: string;
  }>;
  /** Long string values (≥ 50 chars) — V2 will analyze these for
   *  regex extraction of embedded IDs (§7.10.7). */
  embedded_suspects: ReadonlyArray<{
    nodeId: number;
    field: string;
    full_value: string;
  }>;
}

/**
 * Identify "the artifact creator" purely by the caller-supplied
 * `artifactCreatingCallId` (the call the user clicked Save on).
 * We do NOT enumerate frontend_tool names here — that would
 * require keeping an authoritative registry of which tools are
 * "frontend" and which are "data-producing", and frontend tools
 * are currently registered dynamically via CopilotKit
 * (`useValidatedFrontendTool` / `useRenderTool`) with no static
 * list to consult. Trusting the supplied id is simpler and
 * matches the operational reality: if the user clicked Save, that
 * call IS by definition the one we want to materialise as an
 * artifact.
 *
 * Other invocations in the captured chain become workflow nodes
 * verbatim. The edge case "user clicked Save on a data-producing
 * call by accident" would surface as a workflow that includes the
 * UI tool's NEIGHBOURS but not itself — not a useful artifact, but
 * not a silent corruption either; the lineage report records what
 * was kept.
 */

/**
 * The agent-delegation tool name. When `toolName` matches this,
 * the invocation is an agent node, not a tool node — the agent's
 * display string lives at `input.agent` and the agent's input at
 * `input.input` (per the supervisor's `delegate_to_agent` shape).
 */
const AGENT_DELEGATION_TOOL = "delegate_to_agent";

/**
 * The sandboxed-code-execution tool name (D35). When the LLM
 * invokes this via the normal tool-call path, the save pipeline
 * rewrites the captured invocation to a `type: "code"` node
 * (`assembleCodeNode`) instead of a generic tool node. The tool
 * itself stays in the user catalog for the chat side; the
 * canonical workflow spec never references it as a `tool` name.
 */
const CODE_EXECUTION_TOOL = "run_code_in_sandbox";

/**
 * The SQL-extraction tool name (D36). When the LLM invokes this
 * via the normal tool-call path, the save pipeline rewrites the
 * captured invocation to a `type: "sql"` node (`assembleSqlNode`)
 * instead of a generic tool node. Like CODE_EXECUTION_TOOL, the
 * tool itself stays in the user catalog for chat-time use; the
 * canonical workflow spec never references it as a tool `name`.
 */
const SQL_EXTRACTION_TOOL = "extract_dataset_by_sql";

// ─── Entry point ───────────────────────────────────────────────────────

/**
 * Build the LLM-emit workflow spec from a captured run's
 * invocation list. Pure — no DB, no I/O. Throws an `Error` (NOT
 * `WorkflowError` — this is upstream of the workflow error
 * boundary; the orchestrator's catch translates) when input
 * invariants are violated (e.g. `artifactCreatingCallId` not in
 * the invocation list).
 */
export function buildWorkflowSpecFromRunEvents(
  input: BuildFromEventsInput,
): BuildFromEventsOutput {
  const { invocations, artifactCreatingCallId } = input;

  // Step 2: locate the artifact-creating call. It must exist and
  //         must be a frontend_tool.
  const artifactCreator = invocations.find(
    (i) => i.callId === artifactCreatingCallId,
  );
  if (artifactCreator === undefined) {
    throw new Error(
      `buildWorkflowSpecFromRunEvents: artifactCreatingCallId '${artifactCreatingCallId}' not found in invocation list.`,
    );
  }
  // Step 3: filter successful invocations up to (and including)
  //         the artifact-creating call, in chronological order.
  const sortedAsc = [...invocations].sort((a, b) => a.seq - b.seq);
  const upToArtifact = sortedAsc.slice(
    0,
    sortedAsc.findIndex((i) => i.callId === artifactCreatingCallId) + 1,
  );
  // `i.ok` reflects the Nango tool envelope's success bit (see
  // `coalesce-tool-calls.ts::isFailedEnvelope`), NOT just "result
  // JSON parsed". Failed calls produce no usable output, can't be
  // referenced by downstream nodes, and would re-fail at refresh
  // time — they must not become workflow nodes. Concrete case:
  // the LLM hits `extract_dataset_by_sql` three times during a
  // chat, the first two return INVALID_NAME / EXTRACT_FAILED and
  // the third (with a corrected slug / valid SQL) succeeds; the
  // saved workflow must contain only the third call.
  const successful = upToArtifact.filter((i) => i.ok);

  // Step 4: strip the artifact creator. Its input becomes
  //         `strippedFrontendConfig` (→ artifact.content). Every
  //         OTHER call in the successful chain becomes a workflow
  //         node — we don't try to enumerate "other frontend
  //         tools" (the user's click identifies one, and the chain
  //         rarely contains stray rendering tools in practice).
  const strippedFrontendConfig = { ...artifactCreator.input };
  const dataInvocations = successful.filter(
    (i) => i.callId !== artifactCreatingCallId,
  );

  // Steps 7 + 8: assign numeric ids, bucket tag, descriptions.
  let nextId = 0;
  const literalNodes: LLMNode[] = dataInvocations.map((inv) => {
    const id = nextId++;
    return assembleNode(inv, id);
  });

  // Step 5: Strategy Z+ ref reconstruction. Walks nodes in
  //         chronological order; maintains a value→source index
  //         from upstream node outputs; rewrites top-level scalar
  //         input values to @nodes refs when there's a unique
  //         match, accumulates SaveLineageReport.
  const reconciled = reconstructRefs({
    nodes: literalNodes,
    dataInvocations,
    artifactInput: strippedFrontendConfig,
  });

  // Step 9: spec.outputs from the rewritten artifact-creator
  //         input. Only entries that Strategy Z+ successfully
  //         rewrote to a real @nodes ref make it in — static
  //         literals (title, description, optionJson, …) live in
  //         `strippedFrontendConfig` (→ artifact.content), they
  //         are NOT workflow-produced values and have no place
  //         in spec.outputs. If Strategy Z+ produced no refs at
  //         all, a single sentinel pointing at the last data
  //         node's first observed result key is emitted so the
  //         spec satisfies validate.ts's non-empty + parseable
  //         requirements.
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
    depends_on: [], // W1.5.B fills via Strategy Z+
    tool: invocation.toolName,
    input: invocation.input,
  };
}

function assembleAgentNode(
  invocation: ToolInvocation,
  id: number,
): LLMAgentNode {
  // `delegate_to_agent` carries the agent display string at
  // `input.agent` and the agent's actual input at `input.input`
  // (per the supervisor tool's shape). Both are read at save
  // time; the canonical form's `agentId` is filled by canonicalize
  // via EntityCatalog.
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
    // D30 — DEFAULT_AGENT_OUTPUT_SCHEMA. The runner wraps the
    // agent's natural reply as `{ text: <reply> }` at runtime.
    // Observed-shape upgrade lives in W1.5.B (step 6 — if the
    // agent's observed result has additional fields, infer a
    // richer schema; for V1.5.A we always use the default).
    output_schema: { ...DEFAULT_AGENT_OUTPUT_SCHEMA },
  };
}

/**
 * Build a `type: "code"` LLM-emit node from a captured
 * `run_code_in_sandbox` invocation (D35).
 *
 * Wire mapping:
 *   - `input.stdin`           → `code`           (the snippet body)
 *   - `input.command[0]`      → `language`       (V1: python only)
 *   - `input.datasets`        → `input.datasets` (preserved verbatim;
 *                                                 Strategy Z+ array
 *                                                 recursion rewrites
 *                                                 ref elements)
 *   - `input.timeoutSeconds`  → `timeoutSeconds` (lifted to base)
 *   - the literal `command` + `stdin` keys are NOT preserved on the
 *     code node's `input` — they're modeling artefacts of the
 *     sandbox tool's call shape, replaced by the `language` +
 *     `code` first-class fields.
 *
 * `output_schema` is NOT inferred from observed `result.stdout`
 * in V1.x — the canonical node falls back to
 * `DEFAULT_CODE_NODE_OUTPUTS` so `@nodes.X.stdout` refs validate.
 * V2 / observed-shape inference can lift the JSON-shaped stdout
 * into a real schema for downstream typed refs.
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
  // Preserve any non-modelling keys (datasets, env, …) for the
  // engine + Strategy Z+. Drop the keys we promoted to first-class
  // fields (stdin, command).
  const passthroughInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(invocation.input)) {
    if (k === "stdin" || k === "command") continue;
    if (k === "timeoutSeconds") continue; // promoted to base
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
 * `extract_dataset_by_sql` invocation (D36).
 *
 * Wire mapping:
 *   - `input.dataSourceName` → `dataSourceName` (first-class)
 *   - `input.query`          → `query`          (first-class)
 *   - `input.name`           → `name`           (first-class —
 *                                                output dataset slug)
 *   - `input.previewRows`    → DROPPED (chat-affordance, not
 *                              workflow-relevant; engine pins
 *                              previewRows=0 at execute time)
 *   - `input.forceRefresh`   → DROPPED (workflow refresh happens
 *                              at the artifact level, not per-node)
 *
 * Throws on missing required fields — the LLM-emit schema rejects
 * SQL nodes without `dataSourceName + query`, so capturing a
 * malformed invocation should surface a precise diagnostic rather
 * than producing a Zod failure two layers up.
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
 * Pick the language enum from the captured invocation's
 * `command[0]`. V1.x recognises `python3` / `python` →
 * `"python"`; any other prefix falls back to `"python"` with the
 * understanding that the engine's language→runtime table is
 * narrow and the spec is the single source of truth (LLM emitting
 * `bash` style code without declaring it would not be runnable).
 *
 * When the table widens, this becomes a switch + an explicit
 * throw on unknown.
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
  // V1 step 8: tool name + one-line input snippet. Stable / no LLM.
  const sample = describeInputSnippet(invocation.input);
  return sample.length > 0
    ? `${invocation.toolName} — ${sample}`
    : invocation.toolName;
}

function describeInputSnippet(input: Record<string, unknown>): string {
  // Pick the first one or two string/number-valued keys for a
  // human-readable suffix. Skip object/array values (would dump
  // JSON into the description).
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

// ─── Strategy Z+ ref reconstruction (§7.10.2) ──────────────────────────

interface ReconstructInput {
  nodes: ReadonlyArray<LLMNode>;
  dataInvocations: ReadonlyArray<ToolInvocation>;
  artifactInput: Record<string, unknown>;
}

interface ReconstructResult {
  /** Nodes with their input scalars rewritten as @nodes refs where
   *  uniquely matched, and `depends_on` populated from the refs. */
  nodes: LLMNode[];
  /** The artifact-creator's input with the same rewriting applied —
   *  used to derive spec.outputs (step 9). */
  rewrittenArtifactInput: Record<string, unknown>;
  lineageReport: SaveLineageReport;
}

/** Per-value entry in the value→source index. */
interface SourceEntry {
  nodeId: number;
  fieldPath: string;
}

/**
 * Strategy Z+ core. Walks `nodes` in chronological order:
 *   - rewrites each node's top-level input scalars using the
 *     *current* index (only upstream nodes are visible);
 *   - then adds the current node's `result` top-level scalars to
 *     the index for downstream nodes.
 *
 * After the node walk, applies the SAME rewriting to the
 * artifact-creator's input — the index by then contains all node
 * outputs.
 *
 * `depends_on` for each node is derived from the set of upstream
 * node ids referenced by the rewritten input. Sorted ascending
 * for stable output / cache key.
 */
function reconstructRefs(input: ReconstructInput): ReconstructResult {
  const { nodes: literalNodes, dataInvocations, artifactInput } = input;
  const index: Map<string, SourceEntry[]> = new Map();
  const lineage = newLineageAccumulator();
  const rewrittenNodes: LLMNode[] = [];

  for (let i = 0; i < literalNodes.length; i++) {
    const node = literalNodes[i]!;
    const invocation = dataInvocations[i]!; // 1:1 with literalNodes by construction

    // D36: SQL nodes have no generic `input` field — their refs
    // would live in the first-class `query` / `dataSourceName` /
    // `name` slots, none of which Strategy Z+ rewrites in V1
    // capture (chat-time SQL invocations always carry literals
    // there). Pass through unchanged; the addOutputsToIndex call
    // below still registers the SQL node's `result.name` so
    // downstream code nodes' `datasets: [<name>]` get rewritten
    // to `@nodes.X.name`.
    if (node.type === "sql") {
      rewrittenNodes.push(node);
    } else {
      // D35: code nodes' `input` is optional. Treat absent input
      // as empty record for the walker; `withRewrittenInputAndDeps`
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

    // Now add THIS node's outputs to the index so downstream nodes
    // can match.
    if (invocation.result !== null) {
      addOutputsToIndex(invocation.result, node.id, index);
    }
  }

  // Apply the same rewriting to the artifact-creator's input. We
  // don't track its depends_on (it's not a node) — but we DO want
  // the rewritten values for spec.outputs derivation. Use a
  // synthetic nodeId of -1 in lineage entries so admin forensics
  // can distinguish artifact-input rewrites from node rewrites.
  const { rewrittenInput: rewrittenArtifactInput } = rewriteInputViaIndex(
    artifactInput,
    index,
    /* artifactInput nodeId placeholder */ -1,
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
 * caller-supplied value→source `index`. Returns the rewritten
 * input record plus the set of upstream node ids that became
 * dependencies.
 *
 * V1.1 array-aware: when a top-level field is an array, each
 * element is inspected individually and the array is rewritten
 * in place (element-by-element). The dominant real-world case
 * this covers is `run_code_in_sandbox.datasets: [name]`, where
 * the dataset handle from `extract_dataset_by_sql.result.name`
 * needs to flow into the sandbox call's `datasets` array — a
 * top-level-scalar-only walk misses this entirely and yields an
 * empty `depends_on`, breaking the workflow's refresh ordering.
 *
 * Lineage entries for array elements use `field[i]` notation in
 * the `field` slot of `resolved_refs` / `ambiguous_matches` /
 * `candidate_values_no_match`, so admin forensics can locate the
 * specific element. The artifact spec itself only stores the
 * rewritten array — `field[i]` notation is NOT part of the spec's
 * ref language (refs always live at array element positions
 * directly).
 *
 * Out of scope for this pass: nested object recursion (would
 * require either deep field-path encoding in refs — e.g.
 * `@nodes.0.foo.bar` — or a separate strategy; left for V1.x).
 * `embedded_suspects` is still collected only for top-level
 * strings (V2 analysis target); buried suspects in arrays are
 * out of scope.
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
    // Collect embedded-suspect signal at the top-level scalar
    // boundary only — long strings are worth flagging for V2 even
    // if we did rewrite them (multi-source case can hide inside
    // a long ID).
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
 * element (with `field[i]` path-suffix for lineage); everything
 * else passes through unchanged. The `deps` set is mutated in
 * place — callers initialise it once per node and read it after
 * the walk completes.
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
  // Spread keeps the discriminator (`type`) and any bucket-specific
  // fields (agent.output_schema, code.code/language,
  // sql.query/dataSourceName/name, etc.) intact.
  //
  // SQL nodes (D36) have NO `input` field — their refs live in the
  // first-class `query` / `dataSourceName` / `name` string slots,
  // not in a generic input map. Strategy Z+ doesn't currently
  // rewrite those slots (the chat-capture path emits SQL nodes
  // whose query is a self-contained literal); writing `input: {}`
  // onto a SQL node would corrupt the schema. Pass it through
  // with just the updated depends_on (empty for V1 capture).
  if (node.type === "sql") {
    return { ...node, depends_on };
  }
  // Code nodes' `input` is optional. If the original node had no
  // input AND no rewriting produced any keys, omit `input` to keep
  // the canonical spec minimal. Otherwise carry the rewritten
  // record through (it MAY be empty if Strategy Z+ stripped every
  // key — keep it explicit then so admins can see the walk
  // happened).
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
  // Mutable internally; cast to ReadonlyArray in the public type.
  return {
    resolved_refs: [],
    ambiguous_matches: [],
    candidate_values_no_match: [],
    embedded_suspects: [],
  };
}

// ─── spec.outputs (step 9 — uses Strategy Z+ rewrites) ─────────────────

function buildOutputsMap(
  rewrittenArtifactInput: Record<string, unknown>,
  nodes: ReadonlyArray<LLMNode>,
  dataInvocations: ReadonlyArray<ToolInvocation>,
): Record<string, string> {
  // Pass 1: harvest the keys Strategy Z+ actually rewrote to refs.
  //         These are the only artifact-creator inputs that came
  //         from upstream node outputs and therefore deserve a
  //         place in spec.outputs.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rewrittenArtifactInput)) {
    if (typeof value === "string" && value.startsWith("@nodes.")) {
      out[key] = value;
    }
  }
  if (Object.keys(out).length > 0) return out;

  // Pass 2: no refs at all. Either the artifact creator had no
  // upstream lineage that Strategy Z+ could connect, or the
  // captured chain has no data nodes (frontend-only outcome).
  //
  // We still need at least one entry because the LLM-emit schema
  // requires `outputs` to be non-empty. Pick a sensible sentinel
  // pointing at the LAST data node's FIRST observed result field —
  // observed (not guessed) so canonicalize + validate succeed
  // (the field is real; canonicalize will fill output_schema from
  // the registry, and we trust the registry to declare what the
  // tool actually returned).
  if (nodes.length === 0) {
    // Degenerate — no data nodes captured. The pipeline emitted a
    // placeholder no-op node (id 0) so the spec is still valid;
    // reference that.
    return { result: "@nodes.0.result" };
  }
  const lastNode = nodes[nodes.length - 1]!;
  const lastInvocation = dataInvocations[dataInvocations.length - 1];
  const observedKey = pickFirstObservedResultKey(lastInvocation);
  return { result: `@nodes.${lastNode.id}.${observedKey ?? "result"}` };
}

/**
 * Pick the first top-level key in the invocation's observed
 * `result`. Falls back to undefined when the tool returned no
 * result or only non-string scalars we'd rather not reference.
 * Caller substitutes a literal `result` fallback in that case.
 */
function pickFirstObservedResultKey(
  invocation: ToolInvocation | undefined,
): string | undefined {
  if (invocation === undefined || invocation.result === null) return undefined;
  const keys = Object.keys(invocation.result);
  return keys.length > 0 ? keys[0] : undefined;
}

function placeholderNoOpNode(): LLMToolNode {
  // Degenerate spec — frontend_tool called with no data deps.
  // The LLM-emit schema requires nodes.length ≥ 1, so emit a
  // single no-op tool node referring to the artifact's args
  // directly. Modify_workflow (Stage 2) is the path to fix this.
  return {
    id: 0,
    type: "tool",
    description: "(no upstream data) — placeholder; modify_workflow to refine",
    depends_on: [],
    tool: "noop",
    input: {},
  };
}

// ─── Misc helpers ──────────────────────────────────────────────────────

function deriveWorkflowName(artifactCreator: ToolInvocation): string {
  // Best-effort name from the artifact's title-ish fields. Stage 2
  // modify lets the user rename later.
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
