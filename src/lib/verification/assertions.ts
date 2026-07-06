/**
 * Verification — assertion evaluation.
 *
 * Three types, evaluated against the FULL tool result payload (before
 * any persistence-side truncation). All assertions are evaluated even
 * if an earlier one fails so the UI can surface every problem at
 * once.
 *
 * Scope convention (see docs/verification.md):
 *
 *   For MCP tool calls the raw payload is a `CallToolResult` wrapper
 *   `{ content, structuredContent?, isError? }`. To keep assertions
 *   ergonomic for the 90% case, both `jsonpath_equals.path` and
 *   `js_expression.expression` default to **the `structuredContent`
 *   sub-object**, not the root:
 *
 *     jsonpath_equals.path:
 *       "cached"               ⇒ evaluated as $.cached  on structuredContent
 *       "items[0].id"          ⇒ evaluated on structuredContent
 *       "$.isError"            ⇒ ABSOLUTE: evaluated on the full root
 *       "$.structuredContent.cached"  ⇒ ABSOLUTE (still works, just verbose)
 *
 *     js_expression bindings:
 *       `result`               ⇒ structuredContent (or `{}` when absent)
 *       `root`                 ⇒ full CallToolResult
 *
 *   `isError` handling is OUTSIDE assertion scope — the runner already
 *   marks the case `failed` when `root.isError === true`, so users
 *   never need to write `root.isError === false`.
 *
 * See docs/verification.md.
 */

import "server-only";

import { runInNewContext } from "node:vm";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import { JSONPath } from "jsonpath-plus";

import type {
  AssertionResult,
  AssertionSpec,
  JsExpressionAssertion,
  JsonPathEqualsAssertion,
  JsonSchemaAssertion,
} from "./types";

// Shared ajv instance. Reused across cases for compiled-schema cache
// effectiveness. Strict mode is OFF because user-provided schemas
// often omit `$schema` and we tolerate that.
const ajv: Ajv2020 = new Ajv2020({ allErrors: true, strict: false });

/**
 * Synchronous timeout for `js_expression` evaluation. Node's vm
 * timeout uses the V8 interrupt mechanism and BLOCKS the main event
 * loop while a script runs — every concurrent SSE stream / HTTP
 * handler stalls for up to this many milliseconds. Boolean assertions
 * have no business running anywhere near this long, so we keep it
 * tight; V2 will move evaluation into `worker_threads` so a runaway
 * regex (which V8 timeout does NOT interrupt) can't freeze the
 * single-node process. See docs/verification.md.
 */
const JS_EXPRESSION_TIMEOUT_MS: number = 250;

/**
 * Evaluate every assertion against `payload`. Returns one
 * {@link AssertionResult} per input element, in input order.
 *
 * CONTRACT: never throws. A malformed assertion (bad regex, unparseable
 * schema, JS syntax error) becomes `ok: false` with the parser message,
 * so the orchestrator can move on instead of aborting the suite.
 */
export function runAssertions(
  payload: unknown,
  assertions: readonly AssertionSpec[],
): AssertionResult[] {
  return assertions.map((spec, index) => evaluateOne(spec, payload, index));
}

function evaluateOne(
  spec: AssertionSpec,
  payload: unknown,
  index: number,
): AssertionResult {
  switch (spec.type) {
    case "json_schema":
      return evaluateJsonSchema(spec, payload, index);
    case "jsonpath_equals":
      return evaluateJsonPathEquals(spec, payload, index);
    case "js_expression":
      return evaluateJsExpression(spec, payload, index);
    default: {
      // Defensive — caught at the type-system level, but DB rows can
      // contain anything historical.
      const exhaustive: never = spec;
      void exhaustive;
      return {
        index,
        type: (spec as { type: string }).type as AssertionResult["type"],
        ok: false,
        message: `unknown assertion type: ${(spec as { type: string }).type}`,
      };
    }
  }
}

// --- json_schema -------------------------------------------------------------

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
      message: `schema compile failed: ${errMessage(err)}`,
    };
  }
  // Scope convention (see module header): schema validates
  // `structuredContent` so users can describe the data they care about
  // directly, without wrapping every schema in
  // `{ properties: { structuredContent: {...} } }`. Envelope-level
  // validation is an unusual need and can be expressed by writing the
  // schema to require those fields explicitly through a future
  // `scope: "envelope"` escape hatch (not yet implemented).
  const target = extractMcpStructuredData(payload);
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
      : "schema violation",
  };
}

// --- jsonpath_equals ---------------------------------------------------------

function evaluateJsonPathEquals(
  spec: JsonPathEqualsAssertion,
  payload: unknown,
  index: number,
): AssertionResult {
  const { json, absolutePath } = resolveJsonPathScope(spec.path, payload);
  let actualList: unknown[];
  try {
    // JSONPath's `json` field is typed narrowly; payload is `unknown`
    // so we cast through `never` to satisfy the overload picker.
    // `wrap: true` forces the autoStart array-result overload.
    const matches = JSONPath({
      path: absolutePath,
      json: json as never,
      wrap: true,
    });
    actualList = (matches as unknown) as unknown[];
  } catch (err) {
    return {
      index,
      type: "jsonpath_equals",
      ok: false,
      path: spec.path,
      message: `JSONPath parse failed: ${errMessage(err)}`,
    };
  }
  // JSONPath always returns an array; collapse to single match for
  // the common case (`cached` / `$.foo.bar`). Users who want array
  // equality write `items[*]` and the assertion compares the whole
  // array.
  const actual: unknown =
    actualList.length === 1 && !absolutePath.includes("[*]")
      ? actualList[0]
      : actualList;
  const ok = deepEqual(actual, spec.expected);
  return {
    index,
    type: "jsonpath_equals",
    ok,
    path: spec.path,
    expected: spec.expected,
    actual,
    message: ok ? undefined : "value mismatch",
  };
}

/**
 * Resolve a user-supplied JSONPath against the scope convention:
 *
 *   - Path starting with `$` — absolute, evaluated against the full
 *     `CallToolResult` envelope.
 *   - Anything else — relative, evaluated against
 *     `payload.structuredContent` (or `{}` when absent).
 */
function resolveJsonPathScope(
  rawPath: string,
  payload: unknown,
): { json: unknown; absolutePath: string } {
  if (rawPath.startsWith("$")) {
    return { json: payload, absolutePath: rawPath };
  }
  const structured = extractMcpStructuredData(payload);
  // Build an absolute path that jsonpath-plus understands. Two cases:
  //   - bare identifiers / dotted    → "$." + rawPath
  //   - starts with `[` (array idx)  → "$" + rawPath
  const absolutePath = rawPath.startsWith("[")
    ? `$${rawPath}`
    : `$.${rawPath}`;
  return { json: structured, absolutePath };
}

/**
 * Pull `structuredContent` off a CallToolResult-shaped payload. Falls
 * back to `{}` for any non-conforming shape so relative assertions
 * fail with "value mismatch" rather than throwing.
 *
 * Falls back to the envelope itself if content is empty or missing,
 * preventing implicit undefined returns.
 */
export function extractMcpStructuredData(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return {};

  const env = payload as { content?: unknown; structuredContent?: unknown };

  // 1. Prioritize structuredContent if present
  if (env.structuredContent !== undefined && env.structuredContent !== null) {
    return env.structuredContent;
  }

  // 2. Fallback: If structuredContent is missing, scan the content array 
  // for the first item containing a JSON object or stringified JSON.
  if (Array.isArray(env.content) && env.content.length > 0) {
    for (const item of env.content) {
      if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
        const text = item.text;
        if (typeof text === "object" && text !== null) {
          return text;
        }
        if (typeof text === "string") {
          const trimmed = text.trim();
          const looksLikeJson =
            (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
            (trimmed.startsWith("[") && trimmed.endsWith("]"));
          if (looksLikeJson) {
            try {
              return JSON.parse(trimmed);
            } catch {
              // Ignore invalid JSON and continue checking next items
            }
          }
        }
      }
    }

    // 3. If no content item contains parsable JSON, fallback to returning 
    // the content array itself. This allows users to query it via relative paths.
    return env.content;
  }

  // 4. Ultimate fallback: return the envelope itself to prevent implicit undefined,
  // enabling absolute/root path checks to evaluate on the envelope fallback.
  return payload;
}

// --- js_expression -----------------------------------------------------------

function evaluateJsExpression(
  spec: JsExpressionAssertion,
  payload: unknown,
  index: number,
): AssertionResult {
  // Security boundary is the `node:vm` context, not the string wrap.
  // Before "hardening" `(${expr})`, read the security model in
  // docs/verification.md.
  try {
    const ok = runInNewContext(
      `(${spec.expression})`,
      { result: extractMcpStructuredData(payload), root: payload },
      { timeout: JS_EXPRESSION_TIMEOUT_MS, displayErrors: false },
    );
    return {
      index,
      type: "js_expression",
      ok: Boolean(ok),
      message: ok ? undefined : "expression returned falsy",
    };
  } catch (err) {
    return {
      index,
      type: "js_expression",
      ok: false,
      message: `expression threw: ${errMessage(err)}`,
    };
  }
}

// --- helpers -----------------------------------------------------------------

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Deep structural equality. Handles primitives, arrays, plain objects,
 * and Date. NaN equals NaN here (intentional — JSONPath of NaN is rare
 * but matching it should still pass).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  // Asymmetric array-vs-object guard: `typeof [] === 'object'` and
  // `Object.keys([1,2])` returns `['0','1']` — the object branch
  // below would otherwise judge `[1,2]` deep-equal to `{"0":1,"1":2}`.
  // Reject up front so the user gets a clean "value mismatch".
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
