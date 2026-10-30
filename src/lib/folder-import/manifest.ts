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
 * tool noise, the text/image/blocked classification behind
 * {@link classifyFolderPath}). A subsystem overrides only the difference it
 * genuinely has: a knowledge base has no consumer for image bytes and drops them
 * with the noise, a skill keeps them as reference assets.
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

/**
 * Text and code a folder import can carry, whatever lands on the other side of
 * the `/`. Two subsystems read the same bytes as text, so the list is shared.
 */
const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "jsonl",
  "ipynb",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "csv",
  "tsv",
  "xml",
  "sql",
  "py",
  "pyi",
  "sh",
  "bash",
  "zsh",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "html",
  "svg",
  "rst",
  "tex",
]);

/** Images — a reference asset where images are usable, noise where they are not. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico"]);

/** Extension → rejection reason, for the formats no folder import admits. */
const BLOCKED_REASONS: Record<string, string> = {
  // Executables / native binaries
  exe: "executable file",
  dll: "native library",
  so: "native library",
  dylib: "native library",
  bin: "binary file",
  msi: "installer",
  com: "executable file",
  scr: "executable file",
  bat: "Windows batch script",
  cmd: "Windows command script",
  ps1: "PowerShell script",
  jar: "Java archive",
  class: "Java bytecode",
  apk: "Android package",
  app: "application bundle",
  dmg: "macOS disk image",
  pkg: "installer package",
  deb: "Debian package",
  rpm: "RPM package",
  iso: "disk image",
  img: "disk image",
  wasm: "WebAssembly binary",
  // Audio / video
  mp3: "audio file",
  wav: "audio file",
  ogg: "audio file",
  opus: "audio file",
  flac: "audio file",
  aac: "audio file",
  m4a: "audio file",
  wma: "audio file",
  mp4: "video file",
  m4v: "video file",
  mov: "video file",
  avi: "video file",
  mkv: "video file",
  webm: "video file",
  flv: "video file",
  wmv: "video file",
  // Archives
  zip: "archive file",
  tar: "archive file",
  gz: "archive file",
  tgz: "archive file",
  bz2: "archive file",
  xz: "archive file",
  "7z": "archive file",
  rar: "archive file",
  // Fonts
  woff: "font file",
  woff2: "font file",
  ttf: "font file",
  otf: "font file",
  eot: "font file",
  // Binary documents
  pdf: "PDF document",
  doc: "Word document",
  docx: "Word document",
  xls: "Excel workbook",
  xlsx: "Excel workbook",
  ppt: "PowerPoint presentation",
  pptx: "PowerPoint presentation",
  // Binary design/data formats
  psd: "design file",
  ai: "design file",
  sketch: "design file",
  fig: "design file",
  sqlite: "binary database",
  sqlite3: "binary database",
  parquet: "binary data",
  feather: "binary data",
  pkl: "binary data",
  pickle: "binary data",
  npy: "binary data",
  npz: "binary data",
  h5: "binary data",
  onnx: "binary model",
  pt: "binary model",
  pth: "binary model",
};

/**
 * The classification every folder import starts from: noise, then text, then
 * image, then a named rejection, then an unnamed one.
 *
 * A path with no extension is treated as text (`LICENSE`, `Dockerfile`,
 * `README`), because that is what extension-less files in a source tree are;
 * the walker's NUL scan is what actually proves it.
 */
export function classifyFolderPath(path: string): FilePolicyResult {
  const noise: string | null = noiseReason(path);
  if (noise) return { action: "ignore", reason: noise };

  const ext: string = getExtension(path);
  if (ext.length === 0) return { action: "allow-text" };
  if (TEXT_EXTENSIONS.has(ext)) return { action: "allow-text" };
  if (IMAGE_EXTENSIONS.has(ext)) return { action: "allow-image" };
  if (ext in BLOCKED_REASONS) {
    return { action: "block", reason: BLOCKED_REASONS[ext] };
  }
  return { action: "block", reason: "unsupported file type" };
}
