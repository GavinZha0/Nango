/**
 * Server-side `download_file` agent tool. See docs/host-files.md.
 *
 * Single responsibility: fetch one public HTTPS URL and save it inside
 * the mounted host folder. The bytes never enter the conversation —
 * `read_file` is the only way to look at them.
 *
 * Gate order is deliberate: everything cheap and static (root, URL
 * shape, jail, dot segments, extension, existing target) runs BEFORE the
 * first packet leaves the process, so a doomed call never spends a
 * network round trip or leaves a partial file behind.
 */

import "server-only";

import { lstat } from "node:fs/promises";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import {
  getConfig,
  getConfigBoolean,
  getConfigMs,
  getConfigNumber,
} from "@/lib/config";

import { downloadToPath } from "./download.server";
import { jailResolve } from "./runtime-tools";
import {
  downloadFileArgsSchema,
  type DownloadEnvelope,
  type DownloadError,
} from "./schema";

/** Defaults; all admin-tunable in Admin → Config. */
const DEFAULT_MAX_BYTES = 52_428_800; // 50 MiB
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_ALLOWED_EXTENSIONS = [
  "dsc",
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "sql",
  "py",
  "js",
  "ts",
  "sh",
  "html",
  "htm",
].join(",");

function fail(error: DownloadError, message: string): DownloadEnvelope {
  return { ok: false, error, message };
}

/**
 * The extension allowlist matches on the whole lowercased file name, not
 * the text after the last dot: `db5.3_5.3.28+dfsg2-9.dsc` and a
 * hypothetical `archive.tar.gz` both need their real suffix, and an admin
 * listing `tar.gz` must get exactly that rather than `.gz`.
 */
function isAllowedExtension(relPath: string): boolean {
  const name = relPath.split("/").pop()?.toLowerCase() ?? "";
  const allowed = getConfig("download.allowed_extensions", DEFAULT_ALLOWED_EXTENSIONS)
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((entry) => entry.length > 0);
  return allowed.some((ext) => name.endsWith(`.${ext}`));
}

/** Any dot-prefixed segment (`.env`, `.git/config`, `./x`) is refused. */
function hasDotSegment(relPath: string): boolean {
  return relPath.split("/").some((segment) => segment.startsWith("."));
}

export function buildDownloadFileTool(): ToolDefinition {
  return defineTool({
    name: "download_file",
    description:
      "Download one file over HTTPS into the operator-mounted shared " +
      "folder (`host.file.root`). You choose the destination " +
      "`target_path`; the file name is NEVER taken from the URL or from " +
      "the server, so always end it with an explicit file name. The parent " +
      "directory must already exist — create it with `create_folder` first. " +
      "The bytes do NOT enter this conversation: you get " +
      "`{ok, path, sizeBytes, contentType}` and nothing else. To use what " +
      "you downloaded, call `read_file` on the returned `path` (text only; " +
      "a binary comes back NOT_TEXT). " +
      "Each gate is a hard refusal: https only and the host must resolve " +
      "to a public address (BAD_URL, SSRF_BLOCKED — a redirect that lands " +
      "internally is blocked too); the destination extension must be in " +
      "`download.allowed_extensions` (TYPE_DENIED — do not dodge it by " +
      "renaming); a non-2xx response saves nothing (HTTP_STATUS); the body " +
      "must fit `download.max_bytes` (TOO_LARGE) and finish inside " +
      "`download.timeout` (TIMEOUT); an existing target needs " +
      "`overwrite: true` (EXISTS). A too-large, timed-out, or failed " +
      "transfer leaves NO file behind, and dot-prefixed path segments are " +
      "rejected outright (PATH_ESCAPE). " +
      "Other failures: ROOT_NOT_CONFIGURED (no mount — tell the user, do " +
      "not retry), INVALID_PATH, NOT_FOUND (missing parent), IS_DIRECTORY, " +
      "READ_ONLY_MOUNT, WRITE_FAILED, NET_FAILED. This tool writes into " +
      "the user's real folder — download only what the task requires.",
    parameters: downloadFileArgsSchema,
    execute: async (args): Promise<DownloadEnvelope> => {
      const target = args.target_path;
      const urlError = precheckUrl(args.url);
      if (urlError) return urlError;

      const resolved = await jailResolve(target, "write");
      if (!resolved.ok) return resolved;
      if (resolved.relPath === "" || hasDotSegment(resolved.relPath)) {
        return fail(
          "PATH_ESCAPE",
          `"${target}" names a dot-prefixed path inside the shared folder. ` +
            "Dot files and dot-directories are not downloadable targets; " +
            "choose a plain name.",
        );
      }
      if (!isAllowedExtension(resolved.relPath)) {
        return fail(
          "TYPE_DENIED",
          `The extension of "${resolved.relPath}" is not in ` +
            "`download.allowed_extensions`. Renaming the destination to slip " +
            "past the list is not allowed — tell the user which type you " +
            "need and let an admin widen the list.",
        );
      }

      let existedBefore = false;
      try {
        const st = await lstat(resolved.absPath);
        if (st.isDirectory()) {
          return fail(
            "IS_DIRECTORY",
            `"${resolved.relPath}" is a directory. Give a file path.`,
          );
        }
        existedBefore = true;
      } catch {
        existedBefore = false;
      }
      if (existedBefore && !args.overwrite) {
        return fail(
          "EXISTS",
          `"${resolved.relPath}" already exists and was left untouched. ` +
            "Pass `overwrite: true` only when replacing it is what the user " +
            "asked for, or download to a different name.",
        );
      }

      const outcome = await downloadToPath({
        url: args.url,
        absPath: resolved.absPath,
        maxBytes: getConfigNumber("download.max_bytes", DEFAULT_MAX_BYTES),
        timeoutMs: getConfigMs("download.timeout", DEFAULT_TIMEOUT_SECONDS),
        maxRedirects: getConfigNumber("download.max_redirects", DEFAULT_MAX_REDIRECTS),
        allowPrivate: getConfigBoolean("download.allow_private_network", false),
      });
      if (!outcome.ok) return outcome;

      return {
        ok: true,
        // Canonical root-relative path — hand it straight to read_file.
        path: resolved.relPath,
        sizeBytes: outcome.sizeBytes,
        contentType: outcome.contentType,
      };
    },
  });
}

/** Parse + scheme check before any fs or network work. */
function precheckUrl(raw: string): DownloadEnvelope | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(
      "BAD_URL",
      `"${raw.slice(0, 200)}" is not an absolute URL. Pass the full ` +
        "https:// form, not a site name or a relative path.",
    );
  }
  if (url.protocol !== "https:") {
    return fail(
      "BAD_URL",
      `Only https:// URLs can be downloaded (got "${url.protocol}"). Use ` +
        "the https form rather than retrying.",
    );
  }
  return null;
}
