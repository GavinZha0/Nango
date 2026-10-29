/**
 * Browser side of a folder import: turn the `File` list a directory picker
 * reported into the manifest the server expects.
 *
 * CONTRACT: the caps here mirror the server's *defaults* so an oversized folder
 * fails without a round-trip. The server re-checks everything authoritatively
 * against live config, so this mirror can delay a rejection but never grant one.
 */

import {
  type FilePolicyResult,
  type FolderEntry,
} from "./manifest";

export interface CollectPolicy {
  admit: (path: string) => FilePolicyResult;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export type CollectOutcome =
  | { ok: true; entries: FolderEntry[]; skipped: string[] }
  | { ok: false; message: string };

/**
 * `webkitRelativePath` is `"<picked folder>/<sub>/<file>"`. The picked folder is
 * the resource itself, so its name is not part of any stored path.
 */
export function toManifestPath(relativePath: string, name: string): string {
  const rel: string = relativePath || name;
  return rel.includes("/") ? rel.slice(rel.indexOf("/") + 1) : rel;
}

/** Chunked because `String.fromCharCode(...)` has an argument-count limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function collectFolderFiles(
  files: File[],
  policy: CollectPolicy,
): Promise<CollectOutcome> {
  const entries: FolderEntry[] = [];
  const skipped: string[] = [];
  let total = 0;

  for (const file of files) {
    const path: string = toManifestPath(file.webkitRelativePath, file.name);

    const admission: FilePolicyResult = policy.admit(path);
    if (admission.action === "ignore") {
      skipped.push(path);
      continue;
    }
    if (admission.action === "block") {
      return {
        ok: false,
        message: `"${path}" (${admission.reason ?? "unsupported file type"})`,
      };
    }
    if (entries.length >= policy.maxFiles) {
      return {
        ok: false,
        message: `The folder exceeds the ${policy.maxFiles} file limit.`,
      };
    }

    const bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    total += bytes.length;
    if (bytes.length > policy.maxFileBytes) {
      return {
        ok: false,
        message: `"${path}" exceeds the ${Math.round(policy.maxFileBytes / 1024)} KB per-file limit.`,
      };
    }
    if (total > policy.maxTotalBytes) {
      return {
        ok: false,
        message: `The folder exceeds the ${Math.round(policy.maxTotalBytes / 1024 / 1024)} MB total limit.`,
      };
    }

    entries.push({ path, contentBase64: bytesToBase64(bytes) });
  }

  return { ok: true, entries, skipped };
}
