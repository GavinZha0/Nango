/**
 * Universal Assertion Subsystem — server-side evaluation engine.
 *
 * Evaluates deterministic assertions against target payloads, tool execution
 * traces, and execution metrics. Supports full dynamic token and reference
 * variable interpolation.
 *
 * Never throws — maps all evaluation issues into structured AssertionResult envelopes.
 *
 * See docs/verification.md and docs/evaluation.md.
 */

import "server-only";

import { createContext, runInContext, Script } from "node:vm";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import { JSONPath } from "jsonpath-plus";

import type {
  AssertionResult,
  AssertionSpec,
  JsExpressionAssertion,
  JsonPathAssertion,
  JsonSchemaAssertion,
  LlmCustomAssertion,
  LlmDimAssertion,
  MetricAssertion,
  ToolCallAssertion,
  TextMatchAssertion,
  AssertionToolCallSummary,
} from "./types";
import { substituteInputTemplates } from "./variable-resolver";

const ajv: Ajv2020 = new Ajv2020({ allErrors: true, strict: false });

const JS_EXPRESSION_TIMEOUT_MS = 250;

export interface EvaluateAssertionsOptions {
  input?: unknown;
  variables?: Record<string, unknown>;
  runContext?: Record<string, unknown>;
  toolCalls?: Array<{ name: string; args?: unknown }>;
  actualToolCallNames?: string[];
  metrics?: {
    durationMs?: number;
    outputChars?: number;
    toolCallCount?: number;
  };
  toolCallSummary?: AssertionToolCallSummary;
}

export interface EvaluationOutcome {
  deterministicResults: AssertionResult[];
  llmAssertions: Array<{ index: number; spec: LlmDimAssertion | LlmCustomAssertion }>;
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
  let targetPayload = payload;
  const runContext: Record<string, unknown> = { ...(options.runContext ?? {}) };
  if (!runContext.root) {
    runContext.root = payload;
  }

  const isWebAutoEnvelope =
    typeof payload === "object" &&
    payload !== null &&
    "result" in payload &&
    !("content" in payload) &&
    ("_page" in payload || Boolean(options.runContext?.isWebAuto));

  if (isWebAutoEnvelope) {
    const norm = payload as { result?: unknown; _page?: unknown };
    targetPayload = norm.result;
    if (norm._page && !runContext._page) {
      runContext._page = norm._page;
    }
  }

  const mergedOptions: EvaluateAssertionsOptions = {
    ...options,
    runContext,
  };

  const deterministicResults: AssertionResult[] = [];
  const llmAssertions: Array<{ index: number; spec: LlmDimAssertion | LlmCustomAssertion }> = [];

  for (let index = 0; index < assertions.length; index++) {
    const spec = assertions[index];
    if (spec.type === "llm_dim") {
      llmAssertions.push({ index, spec });
      continue;
    }

    if (spec.type === "llm_custom") {
      const customSpec = spec as LlmCustomAssertion;
      const mergedContext: Record<string, unknown> = {
        variables: mergedOptions.variables,
        ...(mergedOptions.runContext ?? {}),
      };

      const resolvedSpec: LlmCustomAssertion = {
        ...customSpec,
        expectation: customSpec.expectation
          ? String(substituteInputTemplates(customSpec.expectation, mergedOptions.input, mergedContext))
          : undefined,
        unexpectation: customSpec.unexpectation
          ? String(substituteInputTemplates(customSpec.unexpectation, mergedOptions.input, mergedContext))
          : undefined,
        reference: customSpec.reference
          ? String(substituteInputTemplates(customSpec.reference, mergedOptions.input, mergedContext))
          : undefined,
        context: customSpec.context
          ? customSpec.context.map((c) => String(substituteInputTemplates(c, mergedOptions.input, mergedContext)))
          : undefined,
      };

      llmAssertions.push({ index, spec: resolvedSpec });
      continue;
    }

    const result = evaluateSingleDeterministic(spec, targetPayload, index, mergedOptions);
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
      return evaluateJsonPath(spec as JsonPathAssertion, payload, index, options);
    case "json_schema":
      return evaluateJsonSchema(spec as JsonSchemaAssertion, payload, index, options);
    case "js_expression":
      return evaluateJsExpression(spec as JsExpressionAssertion, payload, index, options);
    case "tool_call":
      return evaluateToolCall(spec as ToolCallAssertion, index, options);
    case "metric":
      return evaluateMetric(spec as MetricAssertion, index, options);
    case "text_match":
      return evaluateTextMatch(spec as TextMatchAssertion, payload, index, options);
    default: {
      return {
        index,
        type: (spec as { type: string }).type,
        ok: false,
        errored: true,
        errorSource: "config",
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
  options: EvaluateAssertionsOptions,
): AssertionResult {
  const operator = spec.operator || "==";
  const mergedContext: Record<string, unknown> = {
    ...(options.variables ? { variables: options.variables } : {}),
    ...(options.runContext ?? {}),
  };
  const expected = substituteInputTemplates(spec.expected, options.input, mergedContext);
  const rootEnvelope = options.runContext?.root ?? payload;
  const isWebAuto = Boolean(options.runContext?.isWebAuto || (payload && typeof payload === "object" && "_page" in payload));
  const { json, absolutePath } = resolveJsonPathScope(spec.path, payload, rootEnvelope, { isWebAuto });

  // If path contains [*], evaluate wildcard "every" semantics preserving original array indices
  if (absolutePath.includes("[*]")) {
    const starIdx = absolutePath.indexOf("[*]");
    let prefix = absolutePath.slice(0, starIdx);
    const suffix = absolutePath.slice(starIdx + 3);

    if (prefix.endsWith(".")) {
      prefix = prefix.slice(0, -1);
    }

    let targetArray: unknown;
    try {
      if (!prefix || prefix === "$") {
        targetArray = json;
      } else {
        const parentMatches = JSONPath({
          path: prefix,
          json: json as never,
          wrap: true,
        });
        targetArray = parentMatches.length > 0 ? parentMatches[0] : undefined;
      }
    } catch (err) {
      return {
        index,
        type: spec.type,
        ok: false,
        errored: true,
        errorSource: "config",
        path: spec.path,
        message: `JSONPath parse failed: ${errMessage(err)}`,
      };
    }

    if (!Array.isArray(targetArray) || targetArray.length === 0) {
      return {
        index,
        type: spec.type,
        ok: false,
        path: spec.path,
        expected,
        actual: "0 items",
        message: `Path "${spec.path}" matched 0 items`,
      };
    }

    const subPath =
      suffix.startsWith(".") || suffix.startsWith("[")
        ? "$" + suffix
        : suffix
          ? "$." + suffix
          : "";

    const failedIndices: number[] = [];

    for (let i = 0; i < targetArray.length; i++) {
      const item = targetArray[i];
      let itemVal: unknown = undefined;
      let itemExists = true;

      if (!subPath) {
        itemVal = item;
      } else if (item != null && typeof item === "object") {
        try {
          const itemMatches = JSONPath({
            path: subPath,
            json: item as never,
            wrap: true,
          });
          if (itemMatches.length > 0) {
            itemVal = itemMatches[0];
          } else {
            itemExists = false;
          }
        } catch {
          itemExists = false;
        }
      } else {
        itemExists = false;
      }

      let itemPassed = false;
      if (operator === "exists") {
        itemPassed = itemExists;
      } else {
        const res = evaluateOperator(itemVal, operator, expected);
        itemPassed = res.ok;
      }

      if (!itemPassed) {
        failedIndices.push(i);
      }
    }

    if (failedIndices.length === 0) {
      return {
        index,
        type: spec.type,
        ok: true,
        path: spec.path,
        expected,
      };
    }

    const displayIndices =
      failedIndices.length <= 5
        ? failedIndices
        : [...failedIndices.slice(0, 5), `+${failedIndices.length - 5} more`];

    return {
      index,
      type: spec.type,
      ok: false,
      path: spec.path,
      expected,
      actual: displayIndices,
      message: `unsatisfied item(s): [${displayIndices.join(", ")}]`,
    };
  }

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
      errored: true,
      errorSource: "config",
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
    actualList.length === 1 ? actualList[0] : actualList;

  const { ok, mismatchReason } = evaluateOperator(actual, operator, expected);

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

function evaluateOperator(
  actual: unknown,
  operator: string,
  expected: unknown,
): { ok: boolean; mismatchReason?: string } {
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
    default:
      ok = false;
      mismatchReason = `unknown operator "${operator}"`;
      break;
  }

  return { ok, mismatchReason };
}

function resolveJsonPathScope(
  rawPath: string,
  payload: unknown,
  rootEnvelope?: unknown,
  options?: { isWebAuto?: boolean },
): { json: unknown; absolutePath: string } {
  const root = rootEnvelope ?? payload;
  const trimmed = rawPath.trim();

  // 1. Raw envelope addressing: starts with '$', 'root.', or 'root['
  if (trimmed.startsWith("$")) {
    return { json: root, absolutePath: trimmed };
  }
  if (trimmed.startsWith("root.") || trimmed.startsWith("root[")) {
    const subPath = trimmed.startsWith("root.")
      ? trimmed.slice(5)
      : trimmed.slice(4);
    const absolutePath = subPath.startsWith("[") ? `$${subPath}` : `$.${subPath}`;
    return { json: root, absolutePath };
  }

  // 2. Extract structured business data
  const structured = extractStructuredData(payload, options);

  // 3. Whole structured result matching: exact 'result'
  if (trimmed === "result") {
    return { json: structured, absolutePath: "$" };
  }

  // 4. Structured business data child property: starts with 'result.' or 'result['
  if (trimmed.startsWith("result.") || trimmed.startsWith("result[")) {
    const subPath = trimmed.startsWith("result.")
      ? trimmed.slice(7)
      : trimmed.slice(6);
    const absolutePath = subPath.startsWith("[") ? `$${subPath}` : `$.${subPath}`;
    return { json: structured, absolutePath };
  }

  // 5. Direct field addressing on structured business data (e.g. 'orderId', 'items[0]')
  const absolutePath = trimmed.startsWith("[") ? `$${trimmed}` : `$.${trimmed}`;
  return { json: structured, absolutePath };
}

export function extractStructuredData(
  payload: unknown,
  options?: { isWebAuto?: boolean },
): unknown {
  if (typeof payload !== "object" || payload === null) return payload;

  const env = payload as {
    content?: unknown;
    structuredContent?: unknown;
    result?: unknown;
    _page?: unknown;
    _meta?: unknown;
  };

  const meta = env._meta;

  const attachMeta = <T>(target: T): T => {
    if (
      meta !== undefined &&
      typeof target === "object" &&
      target !== null &&
      !Array.isArray(target) &&
      !("_meta" in (target as Record<string, unknown>))
    ) {
      return { ...(target as Record<string, unknown>), _meta: meta } as T;
    }
    return target;
  };

  // 1. MCP standard structuredContent
  if (env.structuredContent !== undefined && env.structuredContent !== null) {
    return attachMeta(env.structuredContent);
  }

  // 2. Standard MCP CallToolResult.content text entry
  if (Array.isArray(env.content) && env.content.length > 0) {
    for (const item of env.content) {
      if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
        const text = item.text;
        if (typeof text === "object" && text !== null) return attachMeta(text);
        if (typeof text === "string") {
          const trimmed = text.trim();
          if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
            try {
              return attachMeta(JSON.parse(trimmed));
            } catch {
              // ignore and continue
            }
          }
        }
      }
    }

    // Non-text content (e.g. image, resource): if single item, unwrap it directly
    if (env.content.length === 1 && env.content[0] && typeof env.content[0] === "object") {
      return attachMeta(env.content[0]);
    }

    return attachMeta(env.content);
  }

  // 3. Web-Auto envelope: has `result` and either `_page` or explicitly marked as isWebAuto
  if (
    env.result !== undefined &&
    env.result !== null &&
    ("_page" in env || Boolean(options?.isWebAuto))
  ) {
    return attachMeta(env.result);
  }

  // 4. Otherwise, payload is already structured business data (never unwrap a standalone `result` field!)
  return attachMeta(payload);
}

// ── 2. JSON Schema Evaluation ────────────────────────────────────────────────

function evaluateJsonSchema(
  spec: JsonSchemaAssertion,
  payload: unknown,
  index: number,
  options?: EvaluateAssertionsOptions,
): AssertionResult {
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(spec.schema as object);
  } catch (err) {
    return {
      index,
      type: "json_schema",
      ok: false,
      errored: true,
      errorSource: "config",
      message: `Schema compile failed: ${errMessage(err)}`,
    };
  }

  const isWebAuto = Boolean(
    options?.runContext?.isWebAuto ||
      (payload && typeof payload === "object" && "_page" in payload),
  );
  const target = extractStructuredData(payload, { isWebAuto });
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

// QUIRK: js_expression 沙箱是"浅加固"而非安全边界。JSON 深拷贝 + 剥离 page
// 只能缩小攻击面（宿主类实例/page 句柄不再被直接暴露），但 node:vm 的
// `constructor.constructor("return process")()` 逃逸在深拷贝后依然可行
// (Node 24 实测可拿到 process/pid)，故此处不构成安全隔离，信任域 = editor。
// 真正隔离需 isolated-vm / 子进程。断言判决不再注入 page 句柄。
function evaluateJsExpression(
  spec: JsExpressionAssertion,
  payload: unknown,
  index: number,
  options: EvaluateAssertionsOptions,
): AssertionResult {
  try {
    const isWebAuto = Boolean(
      options.runContext?.isWebAuto ||
        (payload && typeof payload === "object" && "_page" in payload),
    );
    const structured = extractStructuredData(payload, { isWebAuto });
    const flat = sanitizeForSandbox(structured) as Record<string, unknown> | null;
    const input =
      (sanitizeForSandbox(options.input ?? {}) as Record<string, unknown>) ?? {};
    const variables =
      (sanitizeForSandbox(options.variables ?? {}) as Record<string, unknown>) ?? {};
    const root = sanitizeForSandbox(options.runContext?.root ?? payload);
    const cases =
      (sanitizeForSandbox(options.runContext?.cases ?? {}) as Record<string, unknown>) ?? {};

    // 白名单注入纯数据；不再展开 options.runContext → 自动剥离宿主句柄。
    // CONTRACT: $ 与 root 统一绑定为原始信封；result 绑定为业务整包数据。
    const contextObj = Object.freeze({
      ...(flat && typeof flat === "object" && !Array.isArray(flat) ? flat : {}),
      result: flat,
      $: root,
      root,
      input,
      variables,
      cases,
      ...variables,
    });

    const sandbox = createContext(contextObj);

    const ok = runInContext(
      `(${spec.expression})`,
      sandbox,
      { timeout: JS_EXPRESSION_TIMEOUT_MS, displayErrors: false },
    );

    if (ok) {
      return {
        index,
        type: "js_expression",
        ok: true,
        expression: spec.expression,
      };
    }

    const { actual, expected, operator } = extractJsExpressionActual(
      spec.expression,
      sandbox,
      ok,
    );

    return {
      index,
      type: "js_expression",
      ok: false,
      expression: spec.expression,
      actual,
      expected,
      operator,
      message: "Expression returned falsy",
    };
  } catch (err) {
    const errName = (err as { name?: string })?.name;
    const isTimeout =
      (err as { code?: string })?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ||
      errMessage(err).includes("timed out");
    const isSyntax = err instanceof SyntaxError || errName === "SyntaxError";
    const isTypeError = err instanceof TypeError || errName === "TypeError";
    // Runtime TypeErrors (e.g. data missing expected property) are treated as assertion failed (ok: false, errored: false)
    // Syntax errors, timeouts, or unknown evaluation issues are treated as configuration errors (errored: true)
    const isConfigError = isTimeout || isSyntax || !isTypeError;

    return {
      index,
      type: "js_expression",
      ok: false,
      expression: spec.expression,
      actual: isTypeError ? "undefined" : undefined,
      errored: isConfigError ? true : undefined,
      errorSource: isConfigError ? "config" : undefined,
      message: isTimeout
        ? "Expression execution timed out"
        : `Expression threw: ${errMessage(err)}`,
    };
  }
}

interface ExtractedJsActual {
  actual?: unknown;
  expected?: unknown;
  operator?: string;
}

function parseJsComparison(expr: string): { lhs: string; op: string; rhs: string } | null {
  let s = expr.trim();
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let matchesOuter = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      if (depth === 0) {
        matchesOuter = false;
        break;
      }
    }
    if (matchesOuter) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }

  let depth = 0;
  let inQuote: string | null = null;
  const ops = ["===", "!==", "==", "!=", "<=", ">=", "<", ">"];
  let foundOp: string | null = null;
  let opIdx = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inQuote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      continue;
    }
    if (depth === 0) {
      for (const op of ops) {
        if (s.startsWith(op, i)) {
          if (op === ">" && i > 0 && s[i - 1] === "=") continue;
          if (op === "<" && s[i + 1] === "<") continue;
          if (op === ">" && s[i + 1] === ">") continue;
          foundOp = op;
          opIdx = i;
          break;
        }
      }
      if (foundOp) break;
    }
  }

  if (foundOp && opIdx !== -1) {
    return {
      lhs: s.slice(0, opIdx).trim(),
      op: foundOp,
      rhs: s.slice(opIdx + foundOp.length).trim(),
    };
  }
  return null;
}

function splitLogicalAnd(expr: string): string[] {
  const s = expr.trim();
  const parts: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let start = 0;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inQuote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      continue;
    }
    if (depth === 0 && s.startsWith("&&", i)) {
      parts.push(s.slice(start, i).trim());
      i++;
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

function extractJsExpressionActual(
  expression: string,
  sandbox: import("node:vm").Context,
  rawResult: unknown,
): ExtractedJsActual {
  const andParts = splitLogicalAnd(expression);
  let targetExpr = expression;
  if (andParts.length > 1) {
    for (const part of andParts) {
      try {
        const partOk = runInContext(`(${part})`, sandbox, {
          timeout: JS_EXPRESSION_TIMEOUT_MS,
          displayErrors: false,
        });
        if (!partOk) {
          targetExpr = part;
          break;
        }
      } catch {
        targetExpr = part;
        break;
      }
    }
  }

  const parsedComp = parseJsComparison(targetExpr);
  if (parsedComp) {
    // CONTRACT: Standard assertion structure — LHS is target expression (actual),
    // RHS is expected value/expression. No inverted Yoda condition guesswork.
    let actual: unknown = undefined;
    let expected: unknown = undefined;

    try {
      actual = runInContext(`(${parsedComp.lhs})`, sandbox, {
        timeout: JS_EXPRESSION_TIMEOUT_MS,
        displayErrors: false,
      });
    } catch {
      actual = undefined;
    }

    try {
      expected = runInContext(`(${parsedComp.rhs})`, sandbox, {
        timeout: JS_EXPRESSION_TIMEOUT_MS,
        displayErrors: false,
      });
    } catch {
      expected = parsedComp.rhs;
    }

    return { actual, expected, operator: parsedComp.op };
  }

  if (targetExpr.trim().startsWith("!")) {
    const negated = targetExpr.trim().slice(1).trim();
    try {
      const actual = runInContext(`(${negated})`, sandbox, {
        timeout: JS_EXPRESSION_TIMEOUT_MS,
        displayErrors: false,
      });
      return { actual };
    } catch {
      return { actual: rawResult };
    }
  }

  return { actual: rawResult };
}

// ── 4. Tool Call Trajectory Evaluation ───────────────────────────────────────

function evaluateToolCall(
  spec: ToolCallAssertion,
  index: number,
  options: EvaluateAssertionsOptions,
): AssertionResult {
  if (!spec.toolName || !spec.toolName.trim()) {
    return {
      index,
      type: "tool_call",
      ok: false,
      errored: true,
      errorSource: "config",
      toolName: spec.toolName,
      message: "Tool call assertion is missing required toolName",
    };
  }

  const actualCalls: Array<{ name: string; args?: unknown }> =
    options.toolCalls ??
    (options.actualToolCallNames?.map((name) => ({ name, args: undefined })) || []);
  const matchingCalls = actualCalls.filter((c) => c.name === spec.toolName);

  const target = spec.target ?? "calls";
  const op = spec.operator;
  const threshold = spec.expectedCalls !== undefined ? spec.expectedCalls : 1;

  let actualCount = 0;
  if (target === "calls") {
    actualCount = options.toolCallSummary
      ? (options.toolCallSummary.toolFrequency?.[spec.toolName] ?? 0)
      : matchingCalls.length;
  } else if (target === "failed" || target === "blocked") {
    if (!options.toolCallSummary) {
      return {
        index,
        type: "tool_call",
        ok: false,
        errored: true,
        errorSource: "config",
        toolName: spec.toolName,
        target,
        operator: op,
        expectedCalls: threshold,
        message: `Tool call abnormal status "${target}" requires toolCallSummary, but none was recorded for this execution`,
      };
    }
    actualCount =
      options.toolCallSummary.abnormalDetails?.filter(
        (d) => d.toolName === spec.toolName && d.status === target,
      ).length ?? 0;
  }

  // Evaluate condition
  let ok = false;
  if (op === "<") {
    ok = actualCount < threshold;
  } else if (op === ">") {
    ok = actualCount > threshold;
  } else if (op === "==") {
    ok = actualCount === threshold;
  }

  const expectedDesc = `${target} ${op} ${threshold}`;
  const actualDesc = `${actualCount} ${target}`;

  // Check arguments if specified (only applies when target === "calls")
  if (ok && target === "calls" && spec.expectedArgs && typeof spec.expectedArgs === "object") {
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
        toolName: spec.toolName,
        expectedCalls: threshold,
        operator: op,
        target,
        expected: spec.expectedArgs,
        actual: matchingCalls.map((c) => c.args),
        message: `Tool "${spec.toolName}" matched count (${actualDesc}), but none of the invocations matched the expected arguments`,
      };
    }
  }

  return {
    index,
    type: "tool_call",
    ok,
    toolName: spec.toolName,
    expectedCalls: threshold,
    operator: op,
    target,
    expected: spec.expectedArgs !== undefined && target === "calls" ? spec.expectedArgs : expectedDesc,
    actual: actualCount,
    message: ok
      ? undefined
      : `Tool "${spec.toolName}" ${target} was ${actualCount}, which failed condition "${op} ${threshold}"`,
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
    case "duration_s":
      actualValue =
        metrics.durationMs !== undefined
          ? Math.round((metrics.durationMs / 1000) * 10) / 10
          : undefined;
      break;
    case "output_chars":
      actualValue = metrics.outputChars;
      break;
    case "total_tool_calls":
      actualValue =
        options.toolCallSummary?.totalCalls ?? metrics.toolCallCount;
      break;
    case "tool_failures":
      actualValue = options.toolCallSummary?.failureCount;
      break;
    case "tool_blocked":
      actualValue = options.toolCallSummary?.blockedCount;
      break;
  }

  if (actualValue === undefined) {
    return {
      index,
      type: "metric",
      ok: false,
      errored: true,
      errorSource: "config",
      metric: spec.metric,
      expected: `${spec.operator} ${spec.threshold}`,
      message: `Metric "${spec.metric}" was not recorded for this execution`,
    };
  }

  let ok = false;
  switch (spec.operator) {
    case "<":
      ok = actualValue < spec.threshold;
      break;
    case ">":
      ok = actualValue > spec.threshold;
      break;
    case "==":
      ok = actualValue === spec.threshold;
      break;
  }

  return {
    index,
    type: "metric",
    ok,
    metric: spec.metric,
    expected: `${spec.operator} ${spec.threshold}`,
    actual: actualValue,
    message: ok ? undefined : `Metric ${spec.metric} (${actualValue}) failed rule: ${spec.operator} ${spec.threshold}`,
  };
}

// ── 6. Text Match Evaluation ──────────────────────────────────────────────────

function extractTextFromPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.result === "string") return obj.result;
    try {
      return JSON.stringify(payload);
    } catch {
      return "";
    }
  }
  return String(payload);
}

function evaluateTextMatch(
  spec: TextMatchAssertion,
  payload: unknown,
  index: number,
  _options: EvaluateAssertionsOptions,
): AssertionResult {
  const rawText = extractTextFromPayload(payload);
  const caseSensitive = Boolean(spec.caseSensitive);
  const expected = spec.expected;

  let ok = false;
  let mismatchReason: string | undefined;

  switch (spec.operator) {
    case "contains": {
      const haystack = caseSensitive ? rawText : rawText.toLowerCase();
      const needle = caseSensitive ? expected : expected.toLowerCase();
      ok = haystack.includes(needle);
      if (!ok) {
        mismatchReason = `Expected text to contain "${expected}"`;
      }
      break;
    }
    case "not_contains": {
      const haystack = caseSensitive ? rawText : rawText.toLowerCase();
      const needle = caseSensitive ? expected : expected.toLowerCase();
      ok = !haystack.includes(needle);
      if (!ok) {
        mismatchReason = `Expected text NOT to contain "${expected}"`;
      }
      break;
    }
    case "matches": {
      try {
        const re = new RegExp(expected, caseSensitive ? undefined : "i");
        ok = re.test(rawText);
        if (!ok) {
          mismatchReason = `Expected text to match pattern /${expected}/${caseSensitive ? "" : "i"}`;
        }
      } catch (err) {
        return {
          index,
          type: "text_match",
          ok: false,
          errored: true,
          errorSource: "config",
          expected,
          operator: spec.operator,
          message: `Invalid regular expression: ${errMessage(err)}`,
        };
      }
      break;
    }
    default:
      return {
        index,
        type: "text_match",
        ok: false,
        errored: true,
        errorSource: "config",
        expected,
        operator: spec.operator,
        message: `Unsupported text_match operator: ${spec.operator}`,
      };
  }

  const actualPreview =
    rawText.length > 200 ? `${rawText.slice(0, 197)}...` : rawText;

  return {
    index,
    type: "text_match",
    ok,
    operator: spec.operator,
    expected,
    actual: actualPreview,
    message: ok ? undefined : mismatchReason,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Deep-copy a value into plain, host-free JSON data before it enters the
 *  js_expression sandbox. Functions / host handles (e.g. Playwright page) and
 *  cyclic structures are dropped rather than smuggled into `node:vm`. */
function sanitizeForSandbox(value: unknown): unknown {
  if (value === undefined || typeof value === "function") return null;
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

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

// ── Syntax & Semantic Validation ─────────────────────────────────────────────

export interface SyntaxValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * CONTRACT: validateAssertionSyntax never throws; returns { ok: true } or { ok: false, error: string }.
 *
 * Validates the static syntax/semantics of a single assertion specification.
 *
 * Checks:
 * - `js_expression`: valid JavaScript AST syntax (Script compilation without execution).
 * - `json_schema`: valid JSON Schema (Ajv compilation).
 * - `jsonpath`: valid JSONPath syntax, and valid regex if operator === "matches".
 * - `metric`: valid numeric threshold and operator.
 */
export function validateAssertionSyntax(spec: unknown): SyntaxValidationResult {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, error: "Assertion must be a JSON object" };
  }

  const obj = spec as Record<string, unknown>;
  const type = obj.type;

  switch (type) {
    case "js_expression": {
      const expr = obj.expression;
      if (typeof expr !== "string" || !expr.trim()) {
        return { ok: false, error: "Expression must be a non-empty string" };
      }
      try {
        // QUIRK: Script compilation verifies AST syntax without calling runInContext,
        // avoiding execution side-effects or variable dependency requirements.
        new Script(`(${expr})`);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `Invalid JavaScript expression syntax: ${errMessage(err)}`,
        };
      }
    }

    case "json_schema": {
      const schema = obj.schema;
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        return { ok: false, error: "Schema must be a JSON object" };
      }
      try {
        ajv.compile(schema as object);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `Invalid JSON Schema: ${errMessage(err)}`,
        };
      }
    }

    case "jsonpath": {
      const path = obj.path;
      if (typeof path !== "string" || !path.trim()) {
        return { ok: false, error: "JSONPath path must be a non-empty string" };
      }
      const rawPath = path.trim();
      const absolutePath = rawPath.startsWith("$")
        ? rawPath
        : rawPath.startsWith("[")
          ? `$${rawPath}`
          : `$.${rawPath}`;

      try {
        // QUIRK: jsonpath-plus only compiles [?(...)] filter expressions when iterating
        // over actual array elements. buildDummyForJsonPath populates mock arrays along the
        // path segments so filter syntax errors trigger Jsep compilation errors at check time.
        const dummy = buildDummyForJsonPath(absolutePath);
        JSONPath({ path: absolutePath, json: dummy as never, wrap: true });
      } catch (err) {
        return {
          ok: false,
          error: `Invalid JSONPath syntax: ${errMessage(err)}`,
        };
      }

      if (obj.operator === "matches" && typeof obj.expected === "string" && !obj.expected.includes("{{")) {
        try {
          new RegExp(obj.expected);
        } catch (err) {
          return {
            ok: false,
            error: `Invalid regular expression: ${errMessage(err)}`,
          };
        }
      }
      return { ok: true };
    }

    case "metric": {
      if (typeof obj.threshold !== "number" || !Number.isFinite(obj.threshold)) {
        return { ok: false, error: "Metric threshold must be a finite number" };
      }
      return { ok: true };
    }

    case "text_match": {
      if (typeof obj.expected !== "string" || !obj.expected.trim()) {
        return { ok: false, error: "Text match expected must be a non-empty string" };
      }
      const allowedOps = ["contains", "not_contains", "matches"];
      if (!allowedOps.includes(obj.operator as string)) {
        return {
          ok: false,
          error: `Invalid text_match operator: '${obj.operator}'. Allowed operators are 'contains', 'not_contains', 'matches'.`,
        };
      }
      if (obj.operator === "matches") {
        try {
          new RegExp(obj.expected);
        } catch (err) {
          return {
            ok: false,
            error: `Invalid regular expression: ${errMessage(err)}`,
          };
        }
      }
      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

function buildDummyForJsonPath(path: string): unknown {
  try {
    const segs = JSONPath.toPathArray(path);
    if (segs.length <= 1) return {};
    if (segs[1].startsWith("?(")) {
      return [{}];
    }
    const root: Record<string, unknown> = {};
    let cur: unknown = root;
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      if (s.startsWith("?(")) {
        if (Array.isArray(cur) && cur.length === 0) {
          cur.push({});
        }
      } else {
        const next = segs[i + 1];
        if (next && next.startsWith("?(")) {
          const arr: unknown[] = [{}];
          (cur as Record<string, unknown>)[s] = arr;
          cur = arr;
        } else {
          const child: Record<string, unknown> = {};
          if (Array.isArray(cur)) {
            cur.push(child);
          } else if (typeof cur === "object" && cur !== null) {
            (cur as Record<string, unknown>)[s] = child;
          }
          cur = child;
        }
      }
    }
    return root;
  } catch {
    return {};
  }
}

