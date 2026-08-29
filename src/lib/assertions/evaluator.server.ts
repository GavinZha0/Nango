/**
 * Universal Assertion Subsystem — server-side evaluation engine.
 *
 * Evaluates deterministic assertions against target payloads, tool execution
 * traces, and execution metrics. Never throws — maps all evaluation issues into
 * structured AssertionResult envelopes.
 *
 * See docs/verification.md and docs/evaluation.md.
 */

import "server-only";

import { runInNewContext } from "node:vm";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import { JSONPath } from "jsonpath-plus";

import type {
  AssertionResult,
  AssertionSpec,
  JsExpressionAssertion,
  JsonPathAssertion,
  JsonSchemaAssertion,
  LlmJudgeAssertion,
  MetricAssertion,
  ToolCallAssertion,
} from "./types";

const ajv: Ajv2020 = new Ajv2020({ allErrors: true, strict: false });

const JS_EXPRESSION_TIMEOUT_MS = 250;

export interface EvaluateAssertionsOptions {
  input?: unknown;
  runContext?: Record<string, unknown>;
  toolCalls?: Array<{ name: string; args?: unknown }>;
  actualToolCallNames?: string[];
  metrics?: {
    durationMs?: number;
    outputTokens?: number;
    toolCallCount?: number;
  };
}

export interface EvaluationOutcome {
  deterministicResults: AssertionResult[];
  llmAssertions: Array<{ index: number; spec: LlmJudgeAssertion }>;
  allDeterministicPassed: boolean;
}

/**
 * Execute all assertions against the given target payload and execution context.
 */
export function evaluateAssertions(
  payload: unknown,
  assertions: readonly AssertionSpec[],
  options: EvaluateAssertionsOptions = {},
): EvaluationOutcome {
  const deterministicResults: AssertionResult[] = [];
  const llmAssertions: Array<{ index: number; spec: LlmJudgeAssertion }> = [];

  for (let index = 0; index < assertions.length; index++) {
    const spec = assertions[index];
    if (spec.type === "llm_judge" || spec.type === "expectation" || spec.type === "llm_expectation") {
      llmAssertions.push({ index, spec: spec as LlmJudgeAssertion });
      continue;
    }

    const result = evaluateSingleDeterministic(spec, payload, index, options);
    deterministicResults.push(result);
  }

  const allDeterministicPassed = deterministicResults.every((r) => r.ok);

  return {
    deterministicResults,
    llmAssertions,
    allDeterministicPassed,
  };
}

function evaluateSingleDeterministic(
  spec: AssertionSpec,
  payload: unknown,
  index: number,
  options: EvaluateAssertionsOptions,
): AssertionResult {
  switch (spec.type) {
    case "jsonpath":
    case "jsonpath_equals":
      return evaluateJsonPath(spec as JsonPathAssertion, payload, index, options);
    case "json_schema":
      return evaluateJsonSchema(spec as JsonSchemaAssertion, payload, index);
    case "js_expression":
      return evaluateJsExpression(spec as JsExpressionAssertion, payload, index, options);
    case "tool_call":
      return evaluateToolCall(spec as ToolCallAssertion, index, options);
    case "metric":
      return evaluateMetric(spec as MetricAssertion, index, options);
    default: {
      return {
        index,
        type: (spec as { type: string }).type,
        ok: false,
        message: `Unknown assertion type: ${(spec as { type: string }).type}`,
      };
    }
  }
}

// ── 1. JSONPath Evaluation ───────────────────────────────────────────────────

function evaluateJsonPath(
  spec: JsonPathAssertion,
  payload: unknown,
  index: number,
  _options: EvaluateAssertionsOptions,
): AssertionResult {
  const operator = spec.operator || "==";
  const expected = spec.expected;
  const { json, absolutePath } = resolveJsonPathScope(spec.path, payload);

  let actualList: unknown[];
  try {
    const matches = JSONPath({
      path: absolutePath,
      json: json as never,
      wrap: true,
    });
    actualList = (matches as unknown) as unknown[];
  } catch (err) {
    return {
      index,
      type: spec.type,
      ok: false,
      path: spec.path,
      message: `JSONPath parse failed: ${errMessage(err)}`,
    };
  }

  if (operator === "exists") {
    const exists = actualList.length > 0;
    return {
      index,
      type: spec.type,
      ok: exists,
      path: spec.path,
      expected: "defined",
      actual: exists ? "exists" : "missing",
      message: exists ? undefined : `Path "${spec.path}" does not exist`,
    };
  }

  const actual: unknown =
    actualList.length === 1 && !absolutePath.includes("[*]")
      ? actualList[0]
      : actualList;

  let ok = false;
  let mismatchReason: string | undefined;

  switch (operator) {
    case "==":
      ok = deepEqual(actual, expected);
      if (!ok) mismatchReason = "value mismatch";
      break;
    case "!=":
      ok = !deepEqual(actual, expected);
      if (!ok) mismatchReason = "values should not be equal";
      break;
    case ">":
      ok = typeof actual === "number" && typeof expected === "number" && actual > expected;
      if (!ok) mismatchReason = `expected ${actual} > ${expected}`;
      break;
    case ">=":
      ok = typeof actual === "number" && typeof expected === "number" && actual >= expected;
      if (!ok) mismatchReason = `expected ${actual} >= ${expected}`;
      break;
    case "<":
      ok = typeof actual === "number" && typeof expected === "number" && actual < expected;
      if (!ok) mismatchReason = `expected ${actual} < ${expected}`;
      break;
    case "<=":
      ok = typeof actual === "number" && typeof expected === "number" && actual <= expected;
      if (!ok) mismatchReason = `expected ${actual} <= ${expected}`;
      break;
    case "contains": {
      if (typeof actual === "string" && typeof expected === "string") {
        ok = actual.includes(expected);
      } else if (Array.isArray(actual)) {
        ok = actual.some((item) => deepEqual(item, expected));
      } else {
        ok = false;
      }
      if (!ok) mismatchReason = "item not contained in target";
      break;
    }
    case "matches": {
      if (typeof actual === "string" && typeof expected === "string") {
        try {
          const re = new RegExp(expected);
          ok = re.test(actual);
        } catch {
          ok = false;
        }
      } else {
        ok = false;
      }
      if (!ok) mismatchReason = `target does not match regex /${expected}/`;
      break;
    }
  }

  return {
    index,
    type: spec.type,
    ok,
    path: spec.path,
    expected,
    actual,
    message: ok ? undefined : mismatchReason,
  };
}

function resolveJsonPathScope(
  rawPath: string,
  payload: unknown,
): { json: unknown; absolutePath: string } {
  if (rawPath.startsWith("$")) {
    return { json: payload, absolutePath: rawPath };
  }
  const structured = extractStructuredData(payload);
  const absolutePath = rawPath.startsWith("[")
    ? `$${rawPath}`
    : `$.${rawPath}`;
  return { json: structured, absolutePath };
}

export function extractStructuredData(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return {};

  const env = payload as { content?: unknown; structuredContent?: unknown; result?: unknown };

  if (env.result !== undefined && env.result !== null) {
    return env.result;
  }
  if (env.structuredContent !== undefined && env.structuredContent !== null) {
    return env.structuredContent;
  }

  if (Array.isArray(env.content) && env.content.length > 0) {
    for (const item of env.content) {
      if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
        const text = item.text;
        if (typeof text === "object" && text !== null) return text;
        if (typeof text === "string") {
          const trimmed = text.trim();
          if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
            try {
              return JSON.parse(trimmed);
            } catch {
              // ignore and continue
            }
          }
        }
      }
    }
    return env.content;
  }

  return payload;
}

// ── 2. JSON Schema Evaluation ────────────────────────────────────────────────

function evaluateJsonSchema(
  spec: JsonSchemaAssertion,
  payload: unknown,
  index: number,
): AssertionResult {
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(spec.schema as object);
  } catch (err) {
    return {
      index,
      type: "json_schema",
      ok: false,
      message: `Schema compile failed: ${errMessage(err)}`,
    };
  }

  const target = extractStructuredData(payload);
  const ok = validate(target);
  if (ok) {
    return { index, type: "json_schema", ok: true };
  }

  const firstError = validate.errors?.[0];
  return {
    index,
    type: "json_schema",
    ok: false,
    path: firstError?.instancePath || undefined,
    message: firstError
      ? `${firstError.instancePath || "$"} ${firstError.message ?? "schema violation"}`
      : "Schema violation",
  };
}

// ── 3. JS Expression Evaluation ──────────────────────────────────────────────

function evaluateJsExpression(
  spec: JsExpressionAssertion,
  payload: unknown,
  index: number,
  options: EvaluateAssertionsOptions,
): AssertionResult {
  try {
    const structured = extractStructuredData(payload);
    const contextObj: Record<string, unknown> = {
      ...(typeof structured === "object" && structured !== null && !Array.isArray(structured)
        ? (structured as Record<string, unknown>)
        : {}),
      result: structured,
      $: structured,
      root: payload,
      input: options.input ?? {},
      ...(options.runContext ?? {}),
    };

    const ok = runInNewContext(
      `(${spec.expression})`,
      contextObj,
      { timeout: JS_EXPRESSION_TIMEOUT_MS, displayErrors: false },
    );
    return {
      index,
      type: "js_expression",
      ok: Boolean(ok),
      message: ok ? undefined : "Expression returned falsy",
    };
  } catch (err) {
    return {
      index,
      type: "js_expression",
      ok: false,
      message: `Expression threw: ${errMessage(err)}`,
    };
  }
}

// ── 4. Tool Call Trajectory Evaluation ───────────────────────────────────────

function evaluateToolCall(
  spec: ToolCallAssertion,
  index: number,
  options: EvaluateAssertionsOptions,
): AssertionResult {
  const actualCalls: Array<{ name: string; args?: unknown }> =
    options.toolCalls ??
    (options.actualToolCallNames?.map((name) => ({ name, args: undefined })) || []);
  const matchingCalls = actualCalls.filter((c) => c.name === spec.toolName);
  const callCount = matchingCalls.length;

  const expectedCalls = spec.expectedCalls !== undefined ? spec.expectedCalls : 1;

  if (expectedCalls === 0) {
    const ok = callCount === 0;
    return {
      index,
      type: "tool_call",
      ok,
      expected: `0 calls to ${spec.toolName}`,
      actual: `${callCount} calls`,
      message: ok ? undefined : `Forbidden tool "${spec.toolName}" was called ${callCount} time(s)`,
    };
  }

  if (callCount < expectedCalls) {
    return {
      index,
      type: "tool_call",
      ok: false,
      expected: `>= ${expectedCalls} calls to ${spec.toolName}`,
      actual: `${callCount} calls`,
      message: `Tool "${spec.toolName}" was expected at least ${expectedCalls} time(s) but called ${callCount} time(s)`,
    };
  }

  // Check arguments if specified
  if (spec.expectedArgs && typeof spec.expectedArgs === "object") {
    const hasMatchingArgs = matchingCalls.some((call) => {
      if (!call.args || typeof call.args !== "object") return false;
      const callArgs = call.args as Record<string, unknown>;
      for (const [k, v] of Object.entries(spec.expectedArgs!)) {
        if (!deepEqual(callArgs[k], v)) return false;
      }
      return true;
    });

    if (!hasMatchingArgs) {
      return {
        index,
        type: "tool_call",
        ok: false,
        expected: spec.expectedArgs,
        actual: matchingCalls.map((c) => c.args),
        message: `Tool "${spec.toolName}" was called, but none of the invocations matched the expected arguments`,
      };
    }
  }

  return {
    index,
    type: "tool_call",
    ok: true,
    actual: `${callCount} calls`,
  };
}

// ── 5. Metric Evaluation ─────────────────────────────────────────────────────

function evaluateMetric(
  spec: MetricAssertion,
  index: number,
  options: EvaluateAssertionsOptions,
): AssertionResult {
  const metrics = options.metrics || {};
  let actualValue: number | undefined;

  switch (spec.metric) {
    case "duration_ms":
      actualValue = metrics.durationMs;
      break;
    case "output_tokens":
      actualValue = metrics.outputTokens;
      break;
    case "total_tool_calls":
      actualValue = metrics.toolCallCount;
      break;
  }

  if (actualValue === undefined) {
    return {
      index,
      type: "metric",
      ok: false,
      message: `Metric "${spec.metric}" was not recorded for this execution`,
    };
  }

  let ok = false;
  switch (spec.operator) {
    case "<":
      ok = actualValue < spec.threshold;
      break;
    case "<=":
      ok = actualValue <= spec.threshold;
      break;
    case ">":
      ok = actualValue > spec.threshold;
      break;
    case ">=":
      ok = actualValue >= spec.threshold;
      break;
    case "==":
      ok = actualValue === spec.threshold;
      break;
  }

  return {
    index,
    type: "metric",
    ok,
    expected: `${spec.operator} ${spec.threshold}`,
    actual: actualValue,
    message: ok ? undefined : `Metric ${spec.metric} (${actualValue}) failed rule: ${spec.operator} ${spec.threshold}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}
