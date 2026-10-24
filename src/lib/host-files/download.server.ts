/**
 * Download kernel for the `download_file` tool — network + disk, no jail.
 *
 * The caller (download-runtime-tools.ts) has already resolved the
 * destination through `resolveInJail`, checked the extension allowlist and
 * the dot-segment rule, and read the config budgets. This module never
 * sees an agent-supplied path. See docs/host-files.md.
 *
 * Shape of the transfer, in order:
 *   hop loop (scheme → SSRF guard → request → redirect) → status →
 *   declared-size fast reject → streamed byte budget → atomic rename.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  describeFsError,
  isAbortError,
  isFsError,
  isReadOnlyError,
  isRenameClobberError,
  isTimeoutError,
} from "./fs-error";
import { assertPublicDestination } from "./ssrf-guard.server";

export type DownloadKernelErrorCode =
  | "BAD_URL"
  | "SSRF_BLOCKED"
  | "HTTP_STATUS"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "NET_FAILED"
  | "READ_ONLY_MOUNT"
  | "WRITE_FAILED";

export type DownloadKernelResult =
  | { ok: true; sizeBytes: number; contentType: string | null }
  | { ok: false; error: DownloadKernelErrorCode; message: string };

export interface DownloadRequest {
  /** Already validated as an absolute https URL by the caller. */
  url: string;
  /** Jail-resolved absolute destination. */
  absPath: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowPrivate: boolean;
}

/** Raised by the budget transform when the streamed body overruns the cap. */
class OverBudgetError extends Error {
  constructor(readonly totalBytes: number) {
    super(`body exceeded the ${totalBytes}-byte download budget`);
    this.name = "OverBudgetError";
  }
}

function fail(error: DownloadKernelErrorCode, message: string): DownloadKernelResult {
  return { ok: false, error, message };
}

export async function downloadToPath(req: DownloadRequest): Promise<DownloadKernelResult> {
  let current: URL;
  try {
    current = new URL(req.url);
  } catch {
    return fail("BAD_URL", `"${truncate(req.url)}" is not a valid absolute URL.`);
  }

  // One signal for the whole operation — redirects, headers, and body
  // streaming all die on the same deadline (single-timeout convention,
  // matching sandbox.timeout / ssh.exec_timeout).
  const signal = AbortSignal.timeout(req.timeoutMs);

  for (let hop = 0; hop <= req.maxRedirects; hop += 1) {
    // SECURITY: re-checked per hop. A public URL that 302s to
    // 169.254.169.254 is the single most common way an allowlist-only
    // guard gets walked.
    if (current.protocol !== "https:") {
      return fail(
        "BAD_URL",
        `Only https:// URLs can be downloaded (got "${current.protocol}"). ` +
          "Use the https form of the same URL rather than retrying http.",
      );
    }

    const guard = await assertPublicDestination(current, req.allowPrivate);
    if (!guard.ok) return fail(guard.code, guard.message);

    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal,
        // CONTRACT: identity encoding, because the bytes are stored
        // verbatim. A transparently gzipped body would land on disk
        // labelled with its original extension and never open.
        headers: { "accept-encoding": "identity", "user-agent": "nango-download-file/1" },
      });
    } catch (e) {
      return networkFailure(e, req);
    }

    if (isRedirect(res.status)) {
      const location = res.headers.get("location");
      await discard(res);
      if (!location) {
        return fail(
          "HTTP_STATUS",
          `Redirect ${res.status} from "${truncate(current.href)}" carried no Location header.`,
        );
      }
      try {
        current = new URL(location, current);
      } catch {
        return fail("BAD_URL", `Unusable redirect Location: "${truncate(location)}".`);
      }
      continue;
    }

    if (!res.ok) {
      await discard(res);
      return fail(
        "HTTP_STATUS",
        `The server answered ${res.status} for "${truncate(current.href)}". ` +
          "Nothing was saved — an error page is never stored as a file.",
      );
    }

    return streamToDisk(res, req, signal);
  }

  return fail(
    "BAD_URL",
    `"${truncate(req.url)}" redirected more than ${req.maxRedirects} times.`,
  );
}

// streaming

async function streamToDisk(
  res: Response,
  req: DownloadRequest,
  signal: AbortSignal,
): Promise<DownloadKernelResult> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > req.maxBytes) {
    await discard(res);
    return fail(
      "TOO_LARGE",
      `The server declares ${declared} bytes; the download budget is ` +
        `${req.maxBytes} (config \`download.max_bytes\`). Nothing was saved.`,
    );
  }

  if (res.body === null) {
    return fail("NET_FAILED", `The response for "${truncate(req.url)}" carried no body.`);
  }

  // Temp file sits NEXT TO the target so the rename stays on one
  // filesystem (cross-device renames are not atomic), and carries a
  // random suffix so two concurrent downloads of the same target do not
  // fight over it.
  const tmpPath = `${req.absPath}.tmp-${randomUUID()}`;
  const budget = new ByteBudget(req.maxBytes);
  const out = createWriteStream(tmpPath);
  let renamed = false;

  try {
    await pipeline(Readable.fromWeb(res.body as never), budget, out, { signal });
    try {
      await renameAtomic(tmpPath, req.absPath);
      renamed = true;
    } catch (e) {
      return fsFailure(e);
    }
    return {
      ok: true,
      sizeBytes: budget.totalBytes,
      contentType: res.headers.get("content-type"),
    };
  } catch (e) {
    return transferFailure(e, req);
  } finally {
    // Every non-renamed exit leaves no residue: a budget abort, a killed
    // connection, or an fs error must not strand a partial file in the
    // user's folder.
    if (!renamed) {
      out.destroy();
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  }
}

/** Counts bytes in flight and aborts the pipeline once the cap is crossed. */
class ByteBudget extends Transform {
  totalBytes = 0;
  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: string, done: (err?: Error | null) => void): void {
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.maxBytes) {
      done(new OverBudgetError(this.totalBytes));
      return;
    }
    this.push(chunk);
    done();
  }
}

async function renameAtomic(tmpPath: string, absPath: string): Promise<void> {
  try {
    await rename(tmpPath, absPath);
  } catch (e) {
    if (isRenameClobberError(e)) {
      await unlink(absPath).catch(() => {});
      await rename(tmpPath, absPath);
    } else {
      throw e;
    }
  }
}

// failure classification

function transferFailure(e: unknown, req: DownloadRequest): DownloadKernelResult {
  if (e instanceof OverBudgetError) {
    return fail(
      "TOO_LARGE",
      `The body passed ${e.totalBytes} bytes; the download budget is ` +
        `${req.maxBytes} (config \`download.max_bytes\`). Nothing was saved. ` +
        "Ask the user for a smaller file or an admin to raise the budget.",
    );
  }
  if (isTimeoutError(e) || isAbortError(e)) {
    return fail(
      "TIMEOUT",
      `The transfer for "${truncate(req.url)}" did not finish within the ` +
        "deadline (config `download.timeout`). Nothing was saved — do not " +
        "retry the same URL unchanged; a larger budget needs an admin.",
    );
  }
  // A write-stream errno arrives here, not at the rename: a missing parent
  // directory must read as a destination problem, not a network one.
  if (isFsError(e) || isReadOnlyError(e)) return fsFailure(e);
  return fail("NET_FAILED", `Download failed: ${describe(e)}`);
}

function fsFailure(e: unknown): DownloadKernelResult {
  if (isReadOnlyError(e)) return readOnly();
  return fail(
    "WRITE_FAILED",
    `Could not save the download: ${describeFsError(e)}. The destination ` +
      "directory must already exist — create it with `create_folder`.",
  );
}

function networkFailure(e: unknown, req: DownloadRequest): DownloadKernelResult {
  if (isTimeoutError(e) || isAbortError(e)) {
    return fail(
      "TIMEOUT",
      `"${truncate(req.url)}" did not respond within the deadline (config ` +
        "`download.timeout`). Do not retry the same URL unchanged.",
    );
  }
  return fail("NET_FAILED", `Could not reach "${truncate(req.url)}": ${describe(e)}`);
}

function readOnly(): DownloadKernelResult {
  return fail(
    "READ_ONLY_MOUNT",
    "No write permission for the download destination — the shared folder is " +
      "mounted read-only. Tell the user rather than retrying: an admin must " +
      "drop the `:ro` flag from the shared_folder volume.",
  );
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message;
  return String(e);
}

function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
