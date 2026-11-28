/**
 * Chat attachment policy — shared client/server allowlist, size limits,
 * and inline-text formatting for built-in agent chats.
 */

export const CHAT_ATTACHMENT_IMAGE_MAX_BYTES_KEY =
  "chat.attachment.image_max_bytes" as const;
export const CHAT_ATTACHMENT_TEXT_MAX_BYTES_KEY =
  "chat.attachment.text_max_bytes" as const;

export const DEFAULT_CHAT_ATTACHMENT_IMAGE_MAX_BYTES = 3 * 1024 * 1024; // 3 MiB
export const DEFAULT_CHAT_ATTACHMENT_TEXT_MAX_BYTES = 256 * 1024; // 256 KiB
export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 5;

export type ChatAttachmentKind = "image" | "text";

export interface ChatAttachmentLimits {
  imageMaxBytes: number;
  textMaxBytes: number;
  maxAttachmentsPerMessage: number;
}

export const DEFAULT_CHAT_ATTACHMENT_LIMITS: ChatAttachmentLimits = {
  imageMaxBytes: DEFAULT_CHAT_ATTACHMENT_IMAGE_MAX_BYTES,
  textMaxBytes: DEFAULT_CHAT_ATTACHMENT_TEXT_MAX_BYTES,
  maxAttachmentsPerMessage: MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
};

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const ALLOWED_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
] as const;

export const ALLOWED_TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".log",
  ".sql",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".sh",
  ".go",
  ".java",
  ".rs",
  ".c",
  ".cpp",
  ".h",
] as const;

const IMAGE_MIME_SET: ReadonlySet<string> = new Set(ALLOWED_IMAGE_MIME_TYPES);
const IMAGE_EXT_SET: ReadonlySet<string> = new Set(ALLOWED_IMAGE_EXTENSIONS);
const TEXT_EXT_SET: ReadonlySet<string> = new Set(ALLOWED_TEXT_EXTENSIONS);

const EXT_TO_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const EXT_TO_CODE_LANG: Record<string, string> = {
  ".md": "markdown",
  ".csv": "csv",
  ".tsv": "tsv",
  ".json": "json",
  ".jsonl": "json",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".js": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".py": "python",
  ".sh": "bash",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
};

/** Value passed to `<input accept>` and CopilotKit's `attachments.accept`. */
export const CHAT_ATTACHMENT_ACCEPT: string = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_IMAGE_EXTENSIONS,
  ...ALLOWED_TEXT_EXTENSIONS,
].join(",");

function getLowerExtension(filename: string | null | undefined): string {
  if (!filename) return "";
  const base = filename.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/**
 * Classify a file into `"image"`, `"text"`, or `null` (rejected).
 * Rejects SVG images and non-whitelisted binary/archive/document types.
 */
export function classifyChatAttachment(
  filename: string | null | undefined,
  mimeType: string | null | undefined,
): ChatAttachmentKind | null {
  const mime = (mimeType ?? "").trim().toLowerCase().split(";")[0] ?? "";
  const ext = getLowerExtension(filename);

  if (IMAGE_MIME_SET.has(mime)) return "image";
  if (ext && IMAGE_EXT_SET.has(ext) && (!mime || mime === "application/octet-stream")) {
    return "image";
  }

  if (ext && TEXT_EXT_SET.has(ext)) return "text";
  // Allow extensionless plain-text pastes if MIME is explicitly text/plain.
  if (!ext && mime === "text/plain") return "text";

  return null;
}

/** Normalize MIME type so empty Windows browser MIME strings stay valid downstream. */
export function resolveChatAttachmentMimeType(
  filename: string | null | undefined,
  mimeType: string | null | undefined,
  kind: ChatAttachmentKind,
): string {
  const mime = (mimeType ?? "").trim().toLowerCase().split(";")[0] ?? "";
  const ext = getLowerExtension(filename);

  if (kind === "image") {
    if (IMAGE_MIME_SET.has(mime)) return mime;
    return EXT_TO_IMAGE_MIME[ext] ?? "image/png";
  }

  if (mime.startsWith("text/")) return mime;
  if (mime === "application/json" || mime === "application/xml") return mime;
  return "text/plain";
}

/** Compute exact decoded byte length of a base64 string without allocating a Buffer. */
export function estimateBase64ByteLength(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  if (clean.length === 0) return 0;
  let padding = 0;
  if (clean.endsWith("==")) padding = 2;
  else if (clean.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** Format byte limits concisely for user-facing error messages. */
export function formatAttachmentByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024;
    return Number.isInteger(kb) ? `${kb} KB` : `${kb.toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Wrap decoded text file content in a fence longer than any internal backtick
 * run so Markdown/code files cannot break out of the attachment block.
 */
export function formatInlineTextAttachment(
  filename: string,
  content: string,
): string {
  const safeName = filename.trim() || "file.txt";
  const ext = getLowerExtension(safeName);
  const lang = EXT_TO_CODE_LANG[ext] ?? "text";

  let maxTicks = 2;
  const matches = content.match(/`+/g);
  if (matches) {
    for (const run of matches) {
      if (run.length > maxTicks) maxTicks = run.length;
    }
  }
  const fence = "`".repeat(maxTicks + 1);
  return `[Attached file: ${safeName}]\n${fence}${lang}\n${content}\n${fence}`;
}
