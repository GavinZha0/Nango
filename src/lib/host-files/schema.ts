/**
 * Client-safe schema + result shapes for the `read_file` / `write_file`
 * host-file tools.
 *
 * Same split as `web-search/schema.ts` — shared so LLM-facing arg
 * descriptions and client-side type inference stay in lock-step.
 *
 * Path contract: `path` is ALWAYS root-relative (root = config key
 * `host.file.root`). The jail resolver neutralizes absolute and `..`
 * inputs rather than rejecting the call outright, so a sloppy LLM
 * ("/notes.md") still lands inside the mount.
 */

import { z } from "zod";

// Caps surfaced to the LLM

const MAX_PATH_CHARS = 1024;
const MAX_READ_LIMIT = 2000;

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
        "\"reports/digest.md\". Parent directory must already exist.",
    ),
  content: z
    .string()
    .describe("Full new content of the file (UTF-8 text). Overwrites atomically."),
});

export type ReadFileArgs = z.infer<typeof readFileArgsSchema>;
export type WriteFileArgs = z.infer<typeof writeFileArgsSchema>;

// Result envelopes

export type HostFileError =
  | "ROOT_NOT_CONFIGURED"
  | "INVALID_PATH"
  | "PATH_ESCAPE"
  | "NOT_FOUND"
  | "IS_DIRECTORY"
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
