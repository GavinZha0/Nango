/**
 * Verification — server-side zod schemas for API wire payloads.
 *
 * Shared between case-create and case-PATCH so the two endpoints can
 * never drift on what an `AssertionSpec` looks like over the wire.
 */

import "server-only";

import { z } from "zod";

/**
 * Per-field JSON byte cap for editor-authored payloads (case input,
 * `expected` values, `json_schema` definitions). 8 KB is generous —
 * real MCP tool inputs are typically < 2 KB. The cap protects the
 * `verification_case.input` / `.assertions` jsonb columns from
 * unbounded growth, which would otherwise let a single editor blow
 * up the table (1 MB body × 100 cases × 100 suites = 10 GB).
 *
 * Applied via {@link jsonByteCap} as a zod `.superRefine` rather
 * than at the Next.js body-parser layer so the error message points
 * at the offending FIELD instead of the request as a whole.
 */
const JSON_BYTE_CAP = 8 * 1024;

/**
 * Build a zod refinement that fails when `JSON.stringify(value)`
 * exceeds {@link JSON_BYTE_CAP} UTF-8 bytes. We stringify and measure
 * via `Buffer.byteLength` because zod has no native byte-size
 * primitive and the column it's protecting (`jsonb`) is sized by
 * serialised length on disk.
 */
function jsonByteCap(label: string) {
  return (value: unknown, ctx: z.RefinementCtx): void => {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `${label}: value is not JSON-serialisable`,
      });
      return;
    }
    if (bytes > JSON_BYTE_CAP) {
      ctx.addIssue({
        code: "custom",
        message: `${label}: ${bytes} bytes exceeds the ${JSON_BYTE_CAP}-byte cap`,
      });
    }
  };
}

/** Matches {@link JsonSchemaAssertion}. */
export const jsonSchemaAssertionSchema = z
  .object({
    type: z.literal("json_schema"),
    schema: z
      .record(z.string(), z.unknown())
      .superRefine(jsonByteCap("json_schema.schema")),
  })
  .strict();

/** Matches {@link JsonPathEqualsAssertion}. */
export const jsonPathEqualsAssertionSchema = z
  .object({
    type: z.literal("jsonpath_equals"),
    path: z.string().min(1).max(500),
    expected: z.unknown().superRefine(jsonByteCap("jsonpath_equals.expected")),
  })
  .strict();

/** Matches {@link JsExpressionAssertion}. */
export const jsExpressionAssertionSchema = z
  .object({
    type: z.literal("js_expression"),
    expression: z.string().min(1).max(2000),
  })
  .strict();

/**
 * Discriminated union on the canonical `type` field. The runner,
 * storage layer, and UI all consume this fully-tagged shape so the
 * type information is preserved end-to-end (including the persisted
 * `assertion_results.type` used by the history viewer).
 */
const taggedAssertionSchema = z.discriminatedUnion("type", [
  jsonSchemaAssertionSchema,
  jsonPathEqualsAssertionSchema,
  jsExpressionAssertionSchema,
]);

/**
 * Public assertion schema for wire payloads. `type` is OPTIONAL on the
 * way in — when absent we infer it from the marker field:
 *
 *   - `schema`     → `json_schema`
 *   - `path`       → `jsonpath_equals`
 *   - `expression` → `js_expression`
 *
 * IMPORTANT: this inference only works while the marker fields are
 * DISJOINT across types. If a future assertion variant needs to share
 * any of `schema` / `path` / `expression`, you MUST either (a) keep
 * `type` required for that variant, or (b) introduce a secondary
 * discriminator (e.g. `op`) — do NOT silently extend the table below.
 * The runner relies on `type` being present after parsing.
 */
export const assertionSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type === "string") return obj;
  // Field-presence inference. Order matters only insofar as no two
  // markers should ever both be present on a well-formed payload; if
  // they are, the `.strict()` per-branch object rejects the unknown
  // marker and surfaces a meaningful zod error.
  if ("schema" in obj) return { ...obj, type: "json_schema" };
  if ("path" in obj) return { ...obj, type: "jsonpath_equals" };
  if ("expression" in obj) return { ...obj, type: "js_expression" };
  return obj; // No marker — let the union emit its native error.
}, taggedAssertionSchema);

export const assertionsArraySchema = z.array(assertionSchema).max(50);

/** `input` is opaque JSON; reject obvious non-objects so we always
 *  spread args safely into the MCP `arguments` field. Capped at
 *  {@link JSON_BYTE_CAP} so a single editor can't blow up the
 *  `verification_case.input` jsonb column with multi-MB payloads. */
export const caseInputSchema = z
  .record(z.string(), z.unknown())
  .superRefine(jsonByteCap("case input"));
