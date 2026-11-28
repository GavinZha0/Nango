/**
 * Server-side chat attachment validator & transformer for built-in agents.
 *
 * Keeps allowed images as native multimodal `image` parts and converts allowed
 * text/code/data `document` parts into inline fenced `text` parts so every LLM
 * provider (including DeepSeek, Ollama, and OpenAI-compatible gateways) can
 * read uploaded text files without backend file storage.
 */

import "server-only";

import { getConfigNumber } from "@/lib/config";
import { ApiError } from "@/lib/http/route-handlers";
import {
  CHAT_ATTACHMENT_IMAGE_MAX_BYTES_KEY,
  CHAT_ATTACHMENT_TEXT_MAX_BYTES_KEY,
  DEFAULT_CHAT_ATTACHMENT_IMAGE_MAX_BYTES,
  DEFAULT_CHAT_ATTACHMENT_TEXT_MAX_BYTES,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  classifyChatAttachment,
  estimateBase64ByteLength,
  formatAttachmentByteLimit,
  formatInlineTextAttachment,
  resolveChatAttachmentMimeType,
  type ChatAttachmentLimits,
} from "./attachments";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function getChatAttachmentLimits(): ChatAttachmentLimits {
  return {
    imageMaxBytes: Math.max(
      1024,
      getConfigNumber(
        CHAT_ATTACHMENT_IMAGE_MAX_BYTES_KEY,
        DEFAULT_CHAT_ATTACHMENT_IMAGE_MAX_BYTES,
      ),
    ),
    textMaxBytes: Math.max(
      1024,
      getConfigNumber(
        CHAT_ATTACHMENT_TEXT_MAX_BYTES_KEY,
        DEFAULT_CHAT_ATTACHMENT_TEXT_MAX_BYTES,
      ),
    ),
    maxAttachmentsPerMessage: MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  };
}

interface RawAttachmentSource {
  type?: unknown;
  value?: unknown;
  mimeType?: unknown;
}

interface RawContentPart {
  type?: unknown;
  text?: unknown;
  source?: RawAttachmentSource;
  metadata?: Record<string, unknown>;
}

interface RawChatMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function readFilename(part: RawContentPart, fallback: string): string {
  const raw = part.metadata?.filename;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return fallback;
}

function validateAndDecodeTextBase64(
  base64: string,
  filename: string,
  maxBytes: number,
): string {
  const estimatedBytes = estimateBase64ByteLength(base64);
  if (estimatedBytes > maxBytes) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `Text file "${filename}" exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.`,
    );
  }

  const buf = Buffer.from(base64, "base64");
  if (buf.byteLength > maxBytes) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `Text file "${filename}" exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.`,
    );
  }
  // SECURITY: reject NUL bytes and invalid UTF-8 so binary payloads cannot sneak
  // past extension checks disguised as text files.
  if (buf.includes(0)) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `File "${filename}" is not a valid UTF-8 text file.`,
    );
  }
  try {
    return utf8Decoder.decode(buf);
  } catch {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `File "${filename}" is not a valid UTF-8 text file.`,
    );
  }
}

/**
 * Validate and normalize user message attachments in an AG-UI `/run` payload.
 * Throws `ApiError(400)` if any attachment violates type, size, count, or UTF-8 rules.
 */
export function transformBuiltinChatAttachments(
  messages: RawChatMessage[],
  limits: ChatAttachmentLimits = getChatAttachmentLimits(),
): { messages: RawChatMessage[]; changed: boolean } {
  let changed = false;

  const nextMessages = messages.map((msg) => {
    if (msg?.role !== "user" || !Array.isArray(msg.content)) {
      return msg;
    }

    let attachmentCount = 0;
    let msgChanged = false;
    const nextParts: unknown[] = [];

    for (const rawPart of msg.content) {
      if (!rawPart || typeof rawPart !== "object") {
        nextParts.push(rawPart);
        continue;
      }

      const part = rawPart as RawContentPart;
      if (part.type === "text") {
        nextParts.push(part);
        continue;
      }

      attachmentCount += 1;
      if (attachmentCount > limits.maxAttachmentsPerMessage) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          `At most ${limits.maxAttachmentsPerMessage} files can be attached per message.`,
        );
      }

      const source = part.source;
      if (
        !source ||
        source.type !== "data" ||
        typeof source.value !== "string"
      ) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          "Only inline uploaded image and text files are supported.",
        );
      }

      const rawMime =
        typeof source.mimeType === "string" ? source.mimeType : "";

      if (part.type === "image") {
        const filename = readFilename(part, "image.png");
        const kind = classifyChatAttachment(filename, rawMime);
        if (kind !== "image") {
          throw new ApiError(
            "VALIDATION_FAILED",
            400,
            `Unsupported image type for "${filename}". Supported: PNG, JPG, WebP, GIF.`,
          );
        }
        const byteLen = estimateBase64ByteLength(source.value);
        if (byteLen > limits.imageMaxBytes) {
          throw new ApiError(
            "VALIDATION_FAILED",
            400,
            `Image "${filename}" exceeds the ${formatAttachmentByteLimit(limits.imageMaxBytes)} limit.`,
          );
        }
        const normalizedMime = resolveChatAttachmentMimeType(
          filename,
          rawMime,
          "image",
        );
        if (normalizedMime !== rawMime) {
          msgChanged = true;
          nextParts.push({
            ...part,
            source: { ...source, mimeType: normalizedMime },
          });
        } else {
          nextParts.push(part);
        }
        continue;
      }

      if (part.type === "document") {
        const filename = readFilename(part, "file.txt");
        const kind = classifyChatAttachment(filename, rawMime);
        if (kind !== "text") {
          throw new ApiError(
            "VALIDATION_FAILED",
            400,
            `Unsupported file type for "${filename}". Only text/code files and images are allowed.`,
          );
        }
        const decodedText = validateAndDecodeTextBase64(
          source.value,
          filename,
          limits.textMaxBytes,
        );
        msgChanged = true;
        nextParts.push({
          type: "text",
          text: formatInlineTextAttachment(filename, decodedText),
        });
        continue;
      }

      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        `Unsupported attachment type "${String(part.type)}". Only text/code files and images are allowed.`,
      );
    }

    if (!msgChanged) return msg;
    changed = true;
    return { ...msg, content: nextParts };
  });

  return { messages: changed ? nextMessages : messages, changed };
}
