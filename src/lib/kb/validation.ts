/**
 * Shared input schemas for the knowledge-base REST API.
 *
 * Deliberately free of `import "server-only"`: the editor's live counters and
 * pre-submit validation import the same schemas, so a client cannot be told a
 * different limit from the one the server will enforce.
 */

import { z } from "zod";

import type { KbContentType } from "@/lib/db/schema";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_LABEL_CHARS,
  MIN_DESCRIPTION_CHARS,
} from "@/lib/kb/limits";

/** Globally-unique LLM-facing slug — the same rule as `DATA_SOURCE_NAME_RE`. */
export const KB_COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export const collectionNameSchema = z
  .string()
  .trim()
  .regex(
    KB_COLLECTION_NAME_RE,
    "name must start with a-z and contain only [a-z0-9_-] (max 63 chars)",
  );

/**
 * Collection and group descriptions are injected verbatim into every bound
 * agent's prompt, so a present-but-empty one is a routing line that routes
 * nowhere: both bounds are enforced, not just the ceiling.
 */
export const requiredDescriptionSchema = z
  .string()
  .trim()
  .min(
    MIN_DESCRIPTION_CHARS,
    `description must be at least ${MIN_DESCRIPTION_CHARS} characters`,
  )
  .max(MAX_DESCRIPTION_CHARS, `description exceeds ${MAX_DESCRIPTION_CHARS} characters`);

/**
 * Page descriptions only appear inside a `list_kb_pages` response, so they are
 * optional — and an empty one is stored as NULL, not as an empty line in the
 * agent-facing listing.
 */
export const optionalDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_DESCRIPTION_CHARS, `description exceeds ${MAX_DESCRIPTION_CHARS} characters`)
  .nullable()
  .optional()
  .transform((s) => (s === "" ? null : s));

export const labelSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(MAX_LABEL_CHARS, `must not exceed ${MAX_LABEL_CHARS} characters`);

export const sourceRefSchema = z
  .string()
  .trim()
  .max(MAX_LABEL_CHARS, `source_ref must not exceed ${MAX_LABEL_CHARS} characters`)
  .nullable()
  .optional()
  .transform((s) => (s === "" ? null : s));

/** Mirrors the `kb_page_content_type_check` DB CHECK value set. */
export const KB_CONTENT_TYPES = [
  "text/markdown",
  "text/plain",
  "text/csv",
  "application/json",
  "text/yaml",
  "text/xml",
] as const satisfies readonly KbContentType[];

export const contentTypeSchema = z.enum(KB_CONTENT_TYPES);

/** Group and page rows use bigint identity keys; URL segments arrive as strings. */
export function parseRowId(raw: string): number | null {
  const id: number = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
