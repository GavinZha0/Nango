/**
 * Shared skill-file import policy.
 *
 * The open Agent Skills spec permits any files, but Nango can only execute
 * `.py` / `.sh` scripts and preview images. Everything else is either inert or
 * a storage/security liability, so the import pipeline uses an allowlist.
 *
 * Client-safe: the editor's Add/Rename dialogs use the same rules.
 */

import { getBaseName, getExtension } from "@/lib/skills/file-rules";

export type FilePolicyAction =
  | "allow-text"
  | "allow-image"
  | "ignore"
  | "block";

export interface FilePolicyResult {
  action: FilePolicyAction;
  /** User-facing reason for `ignore` / `block`. */
  reason?: string;
}

/** Text/code/document extensions the agent or editor can actually use. */
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

/** Images are allowed as reference assets; the editor can preview them. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico"]);

/** Extension → rejection reason. */
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

const IGNORED_BASENAMES = new Set([
  "thumbs.db",
  "desktop.ini",
  "ehthumbs.db",
]);

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

function ignoredByPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => segment.startsWith("."))) {
    return true;
  }
  if (segments.some((segment) => IGNORED_DIR_NAMES.has(segment))) return true;
  if (
    segments.some((segment) =>
      IGNORED_DIR_SUFFIXES.some((suffix) => segment.endsWith(suffix)),
    )
  ) {
    return true;
  }
  if (IGNORED_BASENAMES.has(getBaseName(path).toLowerCase())) return true;
  // Emacs leaves `file~` backups next to the original.
  if (getBaseName(path).endsWith("~")) return true;
  return false;
}

/**
 * Classify a path entering a skill import.
 *
 * `ignore` entries are noise a directory tree always carries (dotfiles,
 * caches, OS metadata) and are skipped with a report.
 * `block` entries reject the whole import with a reason.
 */
export function classifyImportPath(path: string): FilePolicyResult {
  if (ignoredByPath(path)) {
    return { action: "ignore", reason: "noise or dotfile" };
  }

  const ext = getExtension(path);
  if (IGNORED_EXTENSIONS.has(ext)) {
    return { action: "ignore", reason: "generated build or tool artifact" };
  }
  if (ext.length === 0) {
    // LICENSE, README, Dockerfile, Makefile, … — text is checked later.
    return { action: "allow-text" };
  }
  if (TEXT_EXTENSIONS.has(ext)) return { action: "allow-text" };
  if (IMAGE_EXTENSIONS.has(ext)) return { action: "allow-image" };
  if (ext in BLOCKED_REASONS) {
    return { action: "block", reason: BLOCKED_REASONS[ext] };
  }
  return { action: "block", reason: "unsupported file type" };
}

/** Editor creation is text-only; binary assets must be imported. */
export function classifyEditorCreatePath(path: string): FilePolicyResult {
  const result = classifyImportPath(path);
  if (result.action === "allow-image") {
    return {
      action: "block",
      reason: "Images and other binary assets must be added through a folder import.",
    };
  }
  if (result.action === "ignore") {
    return {
      action: "block",
      reason: "This name is reserved for generated or OS noise; choose another file name.",
    };
  }
  return result;
}

/** Renaming may keep text or image files; blocked/noise types are refused. */
export function classifyEditorRenamePath(path: string): FilePolicyResult {
  const result = classifyImportPath(path);
  if (result.action === "ignore") {
    return { action: "block", reason: "That path is generated or OS noise and cannot be used." };
  }
  return result;
}

/** Text content must not contain NUL bytes. */
export function validateTextBytes(content: Uint8Array): string | null {
  return content.includes(0)
    ? "Text files cannot contain NUL bytes."
    : null;
}

function ascii(content: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...content.subarray(start, end));
}

/** Verify image magic bytes so a renamed executable cannot slip through. */
export function validateImageBytes(
  path: string,
  content: Uint8Array,
): string | null {
  const ext = getExtension(path);
  if (content.length < 4) {
    return "Image content is too short to be a valid image.";
  }

  if (ext === "png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ok =
      content.length >= signature.length &&
      signature.every((byte, i) => content[i] === byte);
    return ok ? null : "PNG content does not match its extension.";
  }
  if (ext === "jpg" || ext === "jpeg") {
    return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
      ? null
      : "JPEG content does not match its extension.";
  }
  if (ext === "gif") {
    const header = ascii(content, 0, 6);
    return header === "GIF87a" || header === "GIF89a"
      ? null
      : "GIF content does not match its extension.";
  }
  if (ext === "webp") {
    const ok =
      content.length >= 12 &&
      ascii(content, 0, 4) === "RIFF" &&
      ascii(content, 8, 12) === "WEBP";
    return ok ? null : "WEBP content does not match its extension.";
  }
  if (ext === "ico") {
    const ok =
      content[0] === 0x00 &&
      content[1] === 0x00 &&
      content[2] === 0x01 &&
      content[3] === 0x00;
    return ok ? null : "ICO content does not match its extension.";
  }
  return null;
}
