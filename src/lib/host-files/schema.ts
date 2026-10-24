/**
 * Client-safe schema + result shapes for the host-file tools
 * (`read_file` / `write_file` / `edit_file` / `create_folder` /
 * `download_file`).
 *
 * Same split as `web-search/schema.ts` — shared so LLM-facing arg
 * descriptions and client-side type inference stay in lock-step.
 *
 * Path contract: `path` / `target_path` are ALWAYS root-relative (root =
 * config key `host.file.root`). The jail resolver neutralizes absolute and
 * `..` inputs rather than rejecting the call outright, so a sloppy LLM
 * ("/notes.md") still lands inside the mount.
 */

import { z } from "zod";

// Caps surfaced to the LLM

const MAX_PATH_CHARS = 1024;
const MAX_READ_LIMIT = 2000;
const MAX_URL_CHARS = 2048;

// read_file

export const readFileArgsSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .describe(
      "Root-relative file or directory path, e.g. \"notes/todo.md\". " +
        "A directory returns a listing instead of content.",
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based first line to return, or the first entry of a directory " +
        "listing. In a raw file read it is a 1-based BYTE position instead. " +
        "Default 1.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_LIMIT)
    .optional()
    .describe(
      `Max lines to return (1-${MAX_READ_LIMIT}). Default 500. For a ` +
        "directory this is the number of entries, capped at 500. A raw file " +
        "read ignores it — there the byte budget is the only bound.",
    ),
  raw: z
    .boolean()
    .optional()
    .describe(
      "Return the content exactly as stored — no line splitting, no " +
        "line-ending normalization. Applies to files; a directory listing is " +
        "always windowed by `offset`/`limit`. With raw, `offset` counts " +
        "bytes and `limit` is ignored; the read byte budget still caps each " +
        "call and `truncated` reports it. Page with " +
        "`offset: nextByteOffset` — this is how you reach content a line " +
        "window cannot, such as a single line longer than the budget. " +
        "Default false.",
    ),
});

// write_file

export const writeFileArgsSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .describe(
      "Root-relative path of the file to create or overwrite, e.g. " +
        "\"reports/digest.md\". Parent directory must already exist — " +
        "create it with create_folder.",
    ),
  content: z
    .string()
    .describe(
      "Full new content of the file (UTF-8 text). Overwrites atomically, " +
        "or is added at the end when mode is \"append\".",
    ),
  mode: z
    .enum(["overwrite", "append"])
    .optional()
    .describe(
      '"overwrite" (default) replaces the whole file atomically. "append" ' +
        "adds `content` at the end without rewriting, so a file larger than " +
        "the write budget stays writable. Append is not atomic.",
    ),
});

// edit_file

export const editFileArgsSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .describe(
      "Root-relative path of an existing UTF-8 text file, e.g. " +
        "\"notes/todo.md\". Use write_file to create a file.",
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      "Exact text to find, copied verbatim from read_file. Must match one " +
        "place in the file unless replace_all is set.",
    ),
  new_string: z
    .string()
    .describe("Replacement text. An empty string deletes the matched text."),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence instead of requiring a unique match. " +
        "Default false.",
    ),
});

// create_folder

export const createFolderArgsSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .describe(
      "Root-relative directory path to create, e.g. \"inbox/debian\". " +
        "Missing parents are created.",
    ),
});

// download_file

export const downloadFileArgsSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(MAX_URL_CHARS)
    .describe("Absolute https:// URL of the file to fetch."),
  target_path: z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .describe(
      "Root-relative destination INCLUDING the file name, e.g. " +
        "\"inbox/debian/db5.3_5.3.28+dfsg2-9.dsc\". Never derived from the URL.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      "Replace an existing file at `target_path`. Default false — an " +
        "existing target fails with EXISTS.",
    ),
});

export type ReadFileArgs = z.infer<typeof readFileArgsSchema>;
export type WriteFileArgs = z.infer<typeof writeFileArgsSchema>;
export type EditFileArgs = z.infer<typeof editFileArgsSchema>;
export type CreateFolderArgs = z.infer<typeof createFolderArgsSchema>;
export type DownloadFileArgs = z.infer<typeof downloadFileArgsSchema>;

// Result envelopes

export type HostFileError =
  | "ROOT_NOT_CONFIGURED"
  | "INVALID_PATH"
  | "PATH_ESCAPE"
  | "NOT_FOUND"
  | "IS_DIRECTORY"
  | "IS_FILE"
  | "NOT_TEXT"
  | "TOO_LARGE"
  | "READ_ONLY_MOUNT"
  | "READ_FAILED"
  | "WRITE_FAILED";

export interface HostFileErr {
  ok: false;
  error: HostFileError;
  message: string;
}

/** Text content of a file, optionally line-windowed. `truncated`
 *  means more content exists beyond `endLine` — re-call with a higher
 *  `offset`. A line window cannot resume inside the line it cut, so for
 *  that tail use a raw read, which pages by byte through
 *  `nextByteOffset`. */
export interface ReadFileOk {
  ok: true;
  kind: "file";
  /** Canonical root-relative path (posix separators). */
  path: string;
  content: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Line window; absent for raw reads, which are byte-windowed. */
  startLine?: number;
  endLine?: number;
  /** Raw reads only: the 1-based `offset` that continues exactly where this
   *  window stopped (never inside a multi-byte character). Absent at EOF. */
  nextByteOffset?: number;
  truncated: boolean;
}

export interface DirListingEntry {
  name: string;
  kind: "file" | "directory";
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface ListDirOk {
  ok: true;
  kind: "directory";
  path: string;
  modifiedAt: string;
  entries: DirListingEntry[];
  /** 1-based index of the first and last entry in this page. */
  startEntry: number;
  endEntry: number;
  /** More entries exist beyond `endEntry` — re-call with a higher `offset`. */
  truncated: boolean;
}

export type ReadFileEnvelope = ReadFileOk | ListDirOk | HostFileErr;

export interface WriteFileOk {
  ok: true;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  created: boolean;
}

export type WriteFileEnvelope = WriteFileOk | HostFileErr;

/** Match-stage failures that `HostFileError` cannot express. */
export type EditFileError = HostFileError | "NOT_IN_FILE" | "NOT_UNIQUE";

export interface EditFileErr {
  ok: false;
  error: EditFileError;
  message: string;
}

export interface EditFileOk {
  ok: true;
  path: string;
  /** Replacements performed (always 1 unless `replace_all`). */
  replacements: number;
  sizeBytes: number;
  modifiedAt: string;
}

export type EditFileEnvelope = EditFileOk | EditFileErr;

export interface CreateFolderOk {
  ok: true;
  path: string;
  /** False when the directory already existed — an idempotent success. */
  created: boolean;
}

export type CreateFolderEnvelope = CreateFolderOk | HostFileErr;

/** Network-stage failures that `HostFileError` cannot express. */
export type DownloadError =
  | HostFileError
  | "BAD_URL"
  | "SSRF_BLOCKED"
  | "TYPE_DENIED"
  | "HTTP_STATUS"
  | "EXISTS"
  | "TIMEOUT"
  | "NET_FAILED";

export interface DownloadErr {
  ok: false;
  error: DownloadError;
  message: string;
}

/**
 * CONTRACT: no body. The bytes land on disk and are never echoed into
 * the conversation — `read_file` on `path` is the only way to see them.
 */
export interface DownloadOk {
  ok: true;
  /** Canonical root-relative destination, ready to paste into `read_file`. */
  path: string;
  sizeBytes: number;
  contentType: string | null;
}

export type DownloadEnvelope = DownloadOk | DownloadErr;
