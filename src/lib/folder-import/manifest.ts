/**
 * Folder-import manifest — the wire shape a browser directory picker produces.
 *
 * The browser enumerates the user-picked directory (`<input webkitdirectory>`)
 * and POSTs `{ entries: [{ path, contentBase64 }] }`. There is no archive
 * format, no decompression and no symlink surface: the server receives
 * already-materialised file bytes, so the only inflation risk is base64 — a
 * fixed 4/3 factor, bounded by the decoded-size caps the caller enforces.
 *
 * This module holds the rules every folder import shares (path legality, OS and
 * tool noise, text admission). The per-subsystem content allowlist lives with
 * the subsystem.
 *
 * No server-only imports: both the API edge and the browser panel use these rules.
 */

import { z } from "zod";

import { getBaseName, getExtension } from "@/lib/paths";

export const MAX_MANIFEST_ENTRIES = 1000;
export const IMPORT_PATH_MAX_CHARS = 256;

export const folderEntrySchema = z.object({
  path: z.string().min(1).max(IMPORT_PATH_MAX_CHARS),
  contentBase64: z.string().min(1),
});

export type FolderEntry = z.infer<typeof folderEntrySchema>;

export const folderManifestSchema = z
  .object({
    entries: z.array(folderEntrySchema).min(1).max(MAX_MANIFEST_ENTRIES),
  })
  .strict();

/** What a policy decided about one incoming path. */
export type FilePolicyAction = "allow-text" | "allow-image" | "ignore" | "block";

export interface FilePolicyResult {
  action: FilePolicyAction;
  /** User-facing reason for `ignore` / `block`. */
  reason?: string;
}

/**
 * SECURITY: never trust the client — a crafted client can send `..`,
 * back-slashes or absolute paths even though the real directory picker cannot.
 */
export function isUnsafeImportPath(path: string): boolean {
  return path.includes("..") || path.includes("\\") || path.startsWith("/");
}

/** Text content must not contain NUL bytes. */
export function validateTextBytes(content: Uint8Array): string | null {
  return content.includes(0) ? "Text files cannot contain NUL bytes." : null;
}

/**
 * OS junk, editor backups, package-manager caches and build artifacts. A tree
 * copied off disk always carries some of it, so these paths are dropped and
 * reported rather than refused.
 */
const IGNORED_BASENAMES = new Set(["thumbs.db", "desktop.ini", "ehthumbs.db"]);

/** Compiled bytecode, logs, and tool-generated files that are never
 *  authoring sources. */
const IGNORED_EXTENSIONS = new Set([
  // Python bytecode
  "pyc",
  "pyo",
  // Logs, temp files, editor/merge artifacts
  "log",
  "tmp",
  "temp",
  "bak",
  "orig",
  "rej",
  "swp",
  "swo",
  // Tool build metadata
  "tsbuildinfo",
  "map",
  "iml",
  "suo",
  // Package-manager locks and Python build outputs
  "lock",
  "lockb",
  "whl",
  "egg",
  "egg-link",
]);

/** Generated dependency/cache directories, matched at any depth. */
const IGNORED_DIR_NAMES = new Set([
  "__pycache__",
  "node_modules",
  "__MACOSX",
  "venv",
  "virtualenv",
  "__pypackages__",
]);

/** Generated metadata directories, matched by suffix. */
const IGNORED_DIR_SUFFIXES = [".egg-info", ".dist-info", ".egg"];

/** Why a path is folder noise, or null when it is an authoring source. */
export function noiseReason(path: string): string | null {
  const segments: string[] = path.split("/");
  if (segments.some((segment) => segment.startsWith("."))) {
    return "noise or dotfile";
  }
  if (segments.some((segment) => IGNORED_DIR_NAMES.has(segment))) {
    return "noise or dotfile";
  }
  if (
    segments.some((segment) =>
      IGNORED_DIR_SUFFIXES.some((suffix) => segment.endsWith(suffix)),
    )
  ) {
    return "noise or dotfile";
  }
  if (IGNORED_BASENAMES.has(getBaseName(path).toLowerCase())) {
    return "noise or dotfile";
  }
  // Emacs leaves `file~` backups next to the original.
  if (getBaseName(path).endsWith("~")) return "noise or dotfile";

  if (IGNORED_EXTENSIONS.has(getExtension(path))) {
    return "generated build or tool artifact";
  }
  return null;
}
