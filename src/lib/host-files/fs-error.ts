/**
 * Shared fs-error classification for the host-file tools.
 *
 * Lives apart from `runtime-tools.ts` because both the tool layer and the
 * download kernel need it, and neither should import the other to get it.
 */

import "server-only";

/** Human-readable text for the LLM-facing error message. */
export function describeFsError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Mounted read-only, or the container user does not own the directory. */
export function isReadOnlyError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM";
}

/**
 * QUIRK: on Windows, rename onto an existing file fails with EPERM/
 * EEXIST — POSIX replace semantics do not apply. Callers retry by
 * unlinking the target first; the brief absence window is the cost of a
 * cross-platform replace.
 */
export function isRenameClobberError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EEXIST";
}

/**
 * An errno from the disk side of a stream pipeline. A failing
 * `createWriteStream` surfaces through `pipeline()` as a plain error, and
 * without this the agent would be told its network is broken when the
 * destination directory does not exist. Network errnos (ENOTFOUND,
 * ECONNREFUSED, EAI_AGAIN) are deliberately absent.
 */
const FS_ERROR_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ENOSPC",
  "EDQUOT",
  "EBADF",
  "EMFILE",
  "ENFILE",
  "EXDEV",
]);

export function isFsError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && FS_ERROR_CODES.has(code);
}

/** Abort caused by `AbortSignal.timeout` (reason is a TimeoutError). */
export function isTimeoutError(e: unknown): boolean {
  if (e instanceof Error && e.name === "TimeoutError") return true;
  return (e as { code?: unknown } | null)?.code === "ETIMEDOUT";
}

/** Abort from a signal firing at all (timeout, cancel, teardown). */
export function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError";
}
