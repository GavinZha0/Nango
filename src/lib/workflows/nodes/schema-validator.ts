/**
 * Runtime JSON Schema validator for workflow node `input_schema` /
 * `output_schema`.
 *
 * Uses ajv (not Zod): tool / agent schemas reach the engine *as JSON
 * Schema* (Vercel AI SDK `parameters`, MCP `inputSchema`, OpenAPI 3.1
 * `requestBody`), and LLM self-repair benefits from ajv's rich error
 * path / keyword / schemaPath fields. This module is ONLY for runtime
 * dynamic schemas — the static workflow spec layer uses Zod. See
 * AGENTS.md "Schema validation boundary".
 *
 * Configuration:
 *   - `strict: false` — registries (especially MCP servers) ship
 *     schemas with vendor extensions strict mode would reject.
 *   - `allErrors: true` — collect every violation for LLM self-repair.
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
 * Validate `value` against a JSON Schema. Compiled validators are
 * cached by schema content (JSON-stringified key) so repeated
 * validations against the same schema (e.g. across retries or
 * multiple nodes sharing a tool) skip the compile step.
 */
export function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
): SchemaValidationResult {
  let validator: ValidateFunction;
  try {
    validator = compile(schema);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          keyword: "schema",
          message: `Invalid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
          schemaPath: "#",
        },
      ],
    };
  }
  const ok = validator(value) as boolean;
  if (ok) return { ok: true };
  const errors = (validator.errors ?? []).map(normaliseError);
  return { ok: false, errors };
}

/**
 * Format a validation-error array as a single-line, LLM-friendly
 * diagnostic string. Short enough to fit in a WorkflowError message
 * without truncation.
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

/**
 * Compile cache keyed by JSON-stringified schema. Prevents
 * redundant AJV compilations when the same schema is validated
 * multiple times (retries, multiple tool nodes sharing a schema).
 */
const compiledCache = new Map<string, ValidateFunction>();

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = compiledCache.get(key);
  if (cached !== undefined) return cached;
  const validator = getAjv().compile(schema);
  compiledCache.set(key, validator);
  return validator;
}

function normaliseError(e: ErrorObject): SchemaValidationError {
  return {
    path: e.instancePath,
    keyword: e.keyword,
    message: e.message ?? "validation failed",
    schemaPath: e.schemaPath,
  };
}
