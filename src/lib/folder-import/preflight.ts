/**
 * Server-side pre-flight for a folder-import manifest: buffer the body under a
 * cap, then walk the entries once, applying the shared path rules plus the
 * caller's content policy and byte budgets.
 *
 * Caps are injected because they mean different things per subsystem (a skill
 * counts helper files, a knowledge collection counts pages), and each one reads
 * its own config budget. Everything here is measured on **decoded** bytes.
 *
 * @see docs/skills.md
 */

import "server-only";

import { ApiError } from "@/lib/http/route-handlers";

import {
  isUnsafeImportPath,
  validateTextBytes,
  type FilePolicyResult,
  type FolderEntry,
} from "./manifest";

export interface ImportCaps {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface ImportFile {
  path: string;
  content: Buffer;
}

export interface WalkPolicy {
  caps: ImportCaps;
  /** Subsystem allowlist; `ignore` and `block` carry the user-facing reason. */
  admit: (path: string) => FilePolicyResult;
  /** Subsystem path rules; a returned string blocks the entry with that reason. */
  validatePath?: (path: string) => string | null;
  /** Content check for an admitted entry; a returned string blocks the import. */
  validateContent?: (
    path: string,
    content: Buffer,
    action: "allow-text" | "allow-image",
  ) => string | null;
}

export interface WalkOutcome {
  files: ImportFile[];
  /** Noise paths dropped without failing the import; reported to the author. */
  skipped: string[];
  blocked: Array<{ path: string; reason: string }>;
}

/**
 * Reject an oversized body before buffering it. base64 is a fixed 4/3 inflation
 * over the decoded cap, so the ceiling is derived from that plus JSON overhead
 * — it still has to be enforced before `req.json()` allocates.
 */
export function assertBodyWithinCap(req: Request, maxRequestBytes: number): void {
  const contentLength: number = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > maxRequestBytes) {
    throw new ApiError(
      "BAD_REQUEST",
      413,
      `Upload exceeds ${Math.round(maxRequestBytes / 1024 / 1024)} MB.`,
    );
  }
}

export function walkEntries(
  entries: FolderEntry[],
  policy: WalkPolicy,
): WalkOutcome {
  const files: ImportFile[] = [];
  const skipped: string[] = [];
  const blocked: Array<{ path: string; reason: string }> = [];
  let totalDecodedBytes = 0;

  for (const entry of entries) {
    const { path } = entry;

    if (isUnsafeImportPath(path)) {
      throw new ApiError("BAD_REQUEST", 400, `Invalid path in upload: ${path}`);
    }

    // Classify before the subsystem's path rules: noise files start with a dot,
    // which a strict path validator would report as an invalid name instead.
    const admission: FilePolicyResult = policy.admit(path);
    if (admission.action === "ignore") {
      skipped.push(path);
      continue;
    }
    if (admission.action === "block") {
      blocked.push({ path, reason: admission.reason ?? "unsupported file type" });
      continue;
    }

    const pathError: string | null | undefined = policy.validatePath?.(path);
    if (pathError) {
      blocked.push({ path, reason: pathError });
      continue;
    }

    // Count cap before decoding so a hostile entry list fails fast without
    // allocating a Buffer for each one.
    if (files.length >= policy.caps.maxFiles) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `Upload exceeds ${policy.caps.maxFiles} file limit.`,
      );
    }

    const content: Buffer = Buffer.from(entry.contentBase64, "base64");
    totalDecodedBytes += content.length;

    if (content.length > policy.caps.maxFileBytes) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `File ${path} exceeds ${policy.caps.maxFileBytes / 1024} KB limit.`,
      );
    }
    if (totalDecodedBytes > policy.caps.maxTotalBytes) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `Total size exceeds ${policy.caps.maxTotalBytes / 1024 / 1024} MB limit.`,
      );
    }

    if (admission.action === "allow-text") {
      const textError: string | null = validateTextBytes(content);
      if (textError) {
        blocked.push({ path, reason: textError });
        continue;
      }
    }
    const contentError: string | null | undefined = policy.validateContent?.(
      path,
      content,
      admission.action,
    );
    if (contentError) {
      blocked.push({ path, reason: contentError });
      continue;
    }

    files.push({ path, content });
  }

  return { files, skipped, blocked };
}

/**
 * Fail the import when any entry was refused by the content policy. Noise is
 * reported separately (`skipped`): it is not the author's mistake to fix here.
 */
export function assertNoBlocked(
  blocked: Array<{ path: string; reason: string }>,
): void {
  if (blocked.length === 0) return;
  const shown: string = blocked
    .slice(0, 20)
    .map((entry) => `"${entry.path}" (${entry.reason})`)
    .join(", ");
  const more: string = blocked.length > 20 ? ` and ${blocked.length - 20} more` : "";
  throw new ApiError("VALIDATION_FAILED", 400, `Import rejected: ${shown}${more}.`);
}

/** A single path cannot be both a file and a folder. */
export function assertNoPathKindClash(files: ImportFile[]): void {
  const pathSet: Set<string> = new Set(files.map((file) => file.path));
  for (const file of files) {
    const segments: string[] = file.path.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      if (pathSet.has(prefix)) {
        throw new ApiError(
          "BAD_REQUEST",
          400,
          `Upload contains both a file and a folder named "${prefix}".`,
        );
      }
    }
  }
}
