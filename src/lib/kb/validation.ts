/**
 * Shared input schemas for the knowledge-base REST API, plus the one name the
 * client has to build by itself: the slug a picked folder becomes (docs/kb.md).
 *
 * Deliberately free of `import "server-only"`: the editor's live counters and
 * pre-submit validation import the same schemas, so a client cannot be told a
 * different limit from the one the server will enforce.
 */

import { z } from "zod";

import type { KbContentType } from "@/lib/db/schema";
import { folderProblem, pathProblem } from "@/lib/kb/paths";
import { MAX_DESCRIPTION_CHARS, MAX_LABEL_CHARS } from "@/lib/kb/limits";

/**
 * Globally-unique LLM-facing slug — the same character family skill uses for a
 * `name:` (`src/lib/skills/parser.ts`), so a folder can be imported under either
 * system without re-lettering it. The 63-char ceiling is not cosmetic: the agent
 * echoes this string into `kb_name`, which is hard-capped at 63 (`KbNameArg`).
 */
export const KB_COLLECTION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** The rule as one sentence: the API edge, the dialog and the import toast all say it. */
export const KB_COLLECTION_NAME_RULE =
  "name must start with a-z or 0-9 and contain only [a-z0-9_-] (max 63 chars)";

export const collectionNameSchema = z
  .string()
  .trim()
  .regex(KB_COLLECTION_NAME_RE, KB_COLLECTION_NAME_RULE);

/**
 * A folder name is the closest thing an imported tree has to a title, and the
 * KB import has no dialog to type a slug into, so this fold is the whole naming
 * step: lower-case, every run of unsupported characters becomes one `-`, edges
 * trimmed, cut at the length `kb_name` enforces at runtime.
 *
 * CONTRACT: when nothing survives as a legal slug this returns null rather than
 * inventing one. The slug is what the author will type into `list_kb_pages`, so
 * a name they never picked is a handle they cannot find.
 */
export function kbSlugFromFolderName(name: string): string | null {
  const slug: string = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/-+$/, "")
    .slice(0, 63);
  return KB_COLLECTION_NAME_RE.test(slug) ? slug : null;
}

/**
 * A description, either level. Empty is stored as NULL rather than as an empty
 * line in the agent-facing listing, and a collection with no description cannot
 * be enabled — see `enabled ⇒ description` in `src/lib/kb/service.ts`.
 */
export const optionalDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_DESCRIPTION_CHARS, `description exceeds ${MAX_DESCRIPTION_CHARS} characters`)
  .nullable()
  .optional()
  .transform((s) => (s === "" ? null : s));

/**
 * A page path, and so the agent's handle for the page. The rules are the
 * service's — a folder prefix is prose, so it is validated by segment
 * arithmetic rather than a character class (see `src/lib/kb/paths.ts`).
 */
export const pagePathSchema = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .superRefine((path, ctx) => {
    const problem: string | null = pathProblem(path);
    if (problem) {
      ctx.addIssue({ code: "custom", message: `path ${problem}` });
    }
  });

/**
 * A folder prefix on its own: a rename target, or the scope of a folder delete.
 * The empty string is the collection root and is not addressable here — moving
 * pages out to it is a per-page rename.
 */
export const folderPathSchema = z
  .string()
  .trim()
  .min(1, "folder must not be empty")
  .superRefine((folder, ctx) => {
    const problem: string | null = folderProblem(folder);
    if (problem) {
      ctx.addIssue({ code: "custom", message: `folder ${problem}` });
    }
  });

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
