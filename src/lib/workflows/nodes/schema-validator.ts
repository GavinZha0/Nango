/**
 * Runtime JSON Schema validator for workflow node `input_schema`
 * + `output_schema` (V1.4.6 polish layer, §7.2).
 *
 * Why ajv (not Zod):
 *   - Tool / agent schemas reach the engine *as JSON Schema*
 *     (Vercel AI SDK `parameters`, MCP `inputSchema`, OpenAPI 3.1
 *     `requestBody`). Validating with the native shape avoids a
 *     lossy JSON-Schema → Zod translation step.
 *   - LLM self-repair (modify_workflow loop, §3.6.3) benefits from
 *     ajv's rich error path / keyword / schemaPath fields when
 *     surfacing failures back to the model.
 *
 * Boundary kept narrow — this module is ONLY for runtime dynamic
 * schemas. The workflow spec layer (`spec/schema.ts`) still uses
 * Zod because the spec shape itself is statically known at design
 * time. See AGENTS.md "Schema validation boundary".
 *
 * Configuration:
 *   - `strict: false` — registries (especially MCP servers) ship
 *     schemas with vendor extensions / unknown keywords that
 *     ajv's strict mode would reject. We accept them.
 *   - `allErrors: true` — collect every violation, not just the
 *     first one. The LLM self-repair path uses the full list.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

// ─── Public surface ────────────────────────────────────────────────────

export interface SchemaValidationError {
  /** JSON Pointer to the offending value (e.g. "/sql"). */
  path: string;
  /** JSON Schema keyword that triggered the failure (e.g. "type"). */
  keyword: string;
  /** Human-readable diagnostic from ajv (e.g. "must be string"). */
  message: string;
  /** JSON Pointer into the schema (e.g. "#/properties/sql/type"). */
  schemaPath: string;
}

export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; errors: SchemaValidationError[] };

/**
 * Validate `value` against a JSON Schema. Schemas are compiled on
 * each call — for V1 sizes (≤ 50 nodes per workflow), the per-
 * compile cost (~ms) is acceptable. A WeakMap-keyed compile cache
 * is a candidate optimisation for W1.4.7 when the cache layer
 * lands.
 */
export function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
): SchemaValidationResult {
  const validator = compile(schema);
  const ok = validator(value) as boolean;
  if (ok) return { ok: true };
  const errors = (validator.errors ?? []).map(normaliseError);
  return { ok: false, errors };
}

/**
 * Format a validation-error array as a single-line, LLM-friendly
 * diagnostic string. Joined by "; " — short enough to fit in a
 * WorkflowError message without truncation.
 */
export function formatValidationErrors(
  errors: readonly SchemaValidationError[],
): string {
  if (errors.length === 0) return "no schema violations";
  return errors
    .map((e) => `${e.path || "(root)"}: ${e.message} [${e.keyword}]`)
    .join("; ");
}

// ─── Ajv singleton ─────────────────────────────────────────────────────

let cachedAjv: Ajv | null = null;

function getAjv(): Ajv {
  if (cachedAjv !== null) return cachedAjv;
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
  });
  addFormats(ajv);
  cachedAjv = ajv;
  return ajv;
}

function compile(schema: Record<string, unknown>): ValidateFunction {
  return getAjv().compile(schema);
}

function normaliseError(e: ErrorObject): SchemaValidationError {
  return {
    path: e.instancePath,
    keyword: e.keyword,
    message: e.message ?? "validation failed",
    schemaPath: e.schemaPath,
  };
}
