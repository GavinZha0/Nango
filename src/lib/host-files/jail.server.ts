/**
 * Server-only path jail for the host-file tools.
 *
 * The configured root (`host.file.root`) is the ONLY reachable region.
 * Every input path is neutralized before any fs access, then re-checked
 * against the filesystem's own view (realpath) before returning it.
 *
 * SECURITY — threat model: the caller is an LLM whose arguments can be
 * steered by prompt injection in the content it reads. Assumptions:
 *  - Input is hostile and untrusted. It may contain `..`, absolute
 *    paths, drive letters, UNC prefixes, null bytes, or name a
 *    symlink that points outside the mount.
 *  - The root itself is operator-configured and trusted.
 *  - Nothing outside the root may be read or written under any input.
 *
 * Mechanism:
 *  1. Reject null bytes and empty/whitespace input (INVALID_PATH).
 *  2. Treat input as strictly root-relative: leading separators and
 *     drive/UNC prefixes are stripped, then `path.resolve(root, rel)`.
 *     Absolute injection therefore lands inside the root instead of
 *     escaping it.
 *  3. Reject a final component that is a symlink (lstat). Symlinks are
 *     never followed: dangling links would let a write create a file
 *     OUTSIDE the root, and live links would let a read exfiltrate.
 *  4. Containment is evaluated against `fs.realpath` of the parent
 *     directory, so an intermediate directory that is a symlink to an
 *     outside tree is caught even when the leaf does not exist yet.
 *  5. On win32 the containment compare is case-insensitive
 *     (short-name/casing aliases must not produce false rejections),
 *     and both sides are compared with a trailing separator so a
 *     sibling like `/mnt/root-evil` does not pass a `/mnt/root` check.
 */

import "server-only";

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { getConfig } from "@/lib/config";

import type { HostFileError } from "./schema";

export interface JailPathOk {
  ok: true;
  /** Absolute path, safe to hand to fs calls. */
  absPath: string;
  /** Canonical root-relative path with posix separators, for display. */
  relPath: string;
}

export interface JailPathErr {
  ok: false;
  error: HostFileError;
  message: string;
}

export type JailPathResult = JailPathOk | JailPathErr;

/** Configured host-file root, or null when the feature is unconfigured. */
export function getHostFileRoot(): string | null {
  const raw = getConfig("host.file.root", "").trim();
  return raw.length > 0 ? raw : null;
}

function invalidPath(detail: string): JailPathErr {
  return { ok: false, error: "INVALID_PATH", message: detail };
}

/**
 * Root-relative input → contained absolute path. `action` labels the
 * tool call for the error strings the LLM sees.
 */
export async function resolveInJail(
  root: string,
  inputPath: string,
  action: "read" | "write",
): Promise<JailPathResult> {
  if (inputPath.includes("\0")) {
    return invalidPath("Path contains a NUL byte.");
  }
  const trimmed = inputPath.trim();
  if (trimmed.length === 0) {
    return invalidPath("Path is empty.");
  }

  // Strip anything that could re-root the join: a drive spec or UNC
  // prefix, then leading separators. `resolve` honours an absolute
  // second argument on posix and resets on a drive letter on win32, so
  // the separators must go LAST — otherwise the "/Windows/…" remainder
  // of "C:/Windows/…" would re-root the join again.
  let rel = trimmed;
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith("\\\\")) {
    rel = rel.replace(/^[a-zA-Z]:/, "");
  }
  rel = rel.replace(/^[/\\]+/, "");
  if (rel.length === 0) {
    // Input was just "/" or a bare drive — address the root itself.
    rel = ".";
  }

  const absPath = path.resolve(root, rel);

  // 3. Final component must not be a symlink. ENOENT is expected for
  // new-file writes and is not an error here.
  try {
    const st = await lstat(absPath);
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        error: "PATH_ESCAPE",
        message: `Cannot ${action} "${trimmed}": symlinks are not followed inside the host-file root.`,
      };
    }
  } catch (err) {
    if (!isNotFound(err) && !isNotDir(err)) {
      throw err;
    }
  }

  // 4. Containment is proven on the PARENT directory only: it must
  // exist, and its realpath must stay inside the root. realpath on the
  // parent collapses every intermediate symlink component, so a
  // `root/a` that links to an outside tree is caught even when the
  // leaf does not exist yet (which is the write path). Checking the
  // parent rather than walking up to the filesystem root keeps
  // "directory missing" a distinct, actionable error.
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return {
      ok: false,
      error: "ROOT_NOT_CONFIGURED",
      // CONTRACT: this is the only place the operator's mount layout is
      // explained, so it names both fix sites instead of guessing which
      // one is wrong.
      message:
        `Cannot reach the host-file root "${root}". The folder is not mounted ` +
        "into the container (or host.file.root points somewhere else). Ask the " +
        "user to check the shared_folder volume in docker-compose.yaml and the " +
        "`host.file.root` setting in Admin → Config — do not retry.",
    };
  }

  // The root addressed as itself ("" or "/"): its parent is outside the
  // jail by definition, so the parent-containment check must not apply.
  if (normalizeForCompare(absPath) === normalizeForCompare(realRoot)) {
    return { ok: true, absPath: realRoot, relPath: "" };
  }

  const parentDir = path.dirname(absPath);
  let realParent: string;
  try {
    realParent = await realpath(parentDir);
  } catch (err) {
    if (isNotFound(err) || isNotDir(err)) {
      return {
        ok: false,
        error: "NOT_FOUND",
        message:
          `Cannot ${action} "${trimmed}": its parent directory does not ` +
          "exist. For writes, the directory must be created first.",
      };
    }
    throw err;
  }

  if (!isWithin(realRoot, realParent)) {
    return {
      ok: false,
      error: "PATH_ESCAPE",
      message:
        `Cannot ${action} "${trimmed}": the resolved location is outside ` +
        "the configured host-file root.",
    };
  }

  return { ok: true, absPath, relPath: toRelPath(realRoot, absPath) };
}

/** Containment test: `child` is `parent` itself or below it. */
export function isWithin(parent: string, child: string): boolean {
  const normParent = normalizeForCompare(parent);
  const normChild = normalizeForCompare(child);
  if (normChild === normParent) return true;
  return normChild.startsWith(normParent + path.sep);
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Root-relative posix display path. */
function toRelPath(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join("/");
}

function isNotFound(err: unknown): boolean {
  return hasErrorCode(err, "ENOENT");
}

function isNotDir(err: unknown): boolean {
  return hasErrorCode(err, "ENOTDIR");
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  );
}
