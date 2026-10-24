/**
 * Client-safe schema + result shapes for the host-file tools
 * (`read_file` / `write_file` / `create_folder` / `download_file`).
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
    .describe("1-based first line to return. Default 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_LIMIT)
    .optional()
    .describe(`Max lines to return (1-${MAX_READ_LIMIT}). Default 500.`),
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
    .describe("Full new content of the file (UTF-8 text). Overwrites atomically."),
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
 *  means more lines exist beyond `endLine` — re-call with a higher
 *  `offset`. */
export interface ReadFileOk {
  ok: true;
  kind: "file";
  /** Canonical root-relative path (posix separators). */
  path: string;
  content: string;
  sizeBytes: number;
  modifiedAt: string;
  startLine: number;
  endLine: number;
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
  /** Listing exceeded the entry cap and was cut. */
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
