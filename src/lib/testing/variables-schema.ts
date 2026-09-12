/**
 * Suite variables — server-side zod schema shared by all three suite
 * API families (web-auto / verification / evaluation) so CREATE and
 * PATCH can never drift on the wire shape of a `variables` payload.
 *
 * Enforces:
 *   - key naming (matches the UI / resolver contract `^[a-zA-Z_][a-zA-Z0-9_]*$`)
 *   - value structure (literal vs credential discriminated union)
 *   - payload size guards (entry count + serialised byte cap)
 *
 * Legacy flat scalar values (e.g. `{ baseUrl: "https://..." }`) remain
 * accepted for backward compatibility with web-auto suites written
 * before the discriminated shape was introduced.
 */

import "server-only";

import { z } from "zod";

const VARIABLE_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const MAX_VARIABLE_COUNT = 100;
const MAX_VARIABLES_BYTES = 16 * 1024;

const literalVariableSchema = z.object({
  type: z.literal("literal"),
  value: z.union([z.string(), z.number(), z.boolean()]),
  description: z.string().optional(),
});

const credentialVariableSchema = z.object({
  type: z.literal("credential"),
  credentialId: z.string().min(1),
  field: z.string().min(1),
  description: z.string().optional(),
});

const variableDefinitionSchema = z.discriminatedUnion("type", [
  literalVariableSchema,
  credentialVariableSchema,
]);

const variableValueSchema = z.union([
  variableDefinitionSchema,
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const suiteVariablesSchema = z
  .record(z.string().regex(VARIABLE_KEY_REGEX), variableValueSchema)
  .superRefine((map, ctx) => {
    const entryCount = Object.keys(map).length;
    if (entryCount > MAX_VARIABLE_COUNT) {
      ctx.addIssue({
        code: "custom",
        message: `suite variables: ${entryCount} entries exceeds the ${MAX_VARIABLE_COUNT} limit`,
      });
      return;
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(map) ?? "", "utf8");
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "suite variables: value is not JSON-serialisable",
      });
      return;
    }
    if (bytes > MAX_VARIABLES_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `suite variables: ${bytes} bytes exceeds the ${MAX_VARIABLES_BYTES}-byte cap`,
      });
    }
  });