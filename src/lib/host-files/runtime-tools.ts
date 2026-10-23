/**
 * Server-side `read_file` / `write_file` agent tools.
 *
 * Both operate exclusively inside the operator-mounted root configured
 * by `host.file.root` (default `/shared_folder`, the container-side of
 * the compose bind mount). There is no availability gate: a missing or
 * mis-mounted root fails the call with `ROOT_NOT_CONFIGURED` and the
 * error message tells the agent which mount to check.
 *
 * Scope: UTF-8 text files only. No delete, no rename, no move, no
 * append — `write_file` replaces whole files.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import readline from "node:readline";

// QUIRK: `Buffer.isUtf8` is not exposed on the global Buffer in this
// project's Node runtime, so the exact validator comes from the module.
import { isUtf8 } from "node:buffer";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { getConfigNumber } from "@/lib/config";

import { getHostFileRoot, resolveInJail } from "./jail.server";
import {
  readFileArgsSchema,
  writeFileArgsSchema,
  type DirListingEntry,
  type HostFileErr,
  type HostFileError,
  type ListDirOk,
  type ReadFileEnvelope,
  type ReadFileOk,
  type WriteFileEnvelope,
} from "./schema";

/** Default per-call byte budgets; admin-tunable via config. */
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_READ_LIMIT_LINES = 500;
const MAX_LIST_ENTRIES = 500;

function err(error: HostFileError, message: string): HostFileErr {
  return { ok: false, error, message };
}

function readMaxBytes(): number {
  return getConfigNumber("host.file.read_max_bytes", DEFAULT_MAX_BYTES);
}

function writeMaxBytes(): number {
  return getConfigNumber("host.file.write_max_bytes", DEFAULT_MAX_BYTES);
}

/**
 * Resolve the configured root and the jailed path, funneling every
 * pre-flight failure into the error envelope.
 */
async function jailResolve(
  path: string,
  action: "read" | "write",
): Promise<{ ok: true; absPath: string; relPath: string } | HostFileErr> {
  const root = getHostFileRoot();
  if (root === null) {
    return err(
      "ROOT_NOT_CONFIGURED",
      "Host file access is off — there is no permission to read or write " +
        "because `host.file.root` is empty. Ask the user to check the " +
        "container's shared_folder mount and point `host.file.root` " +
        "(Admin → Config) at that container path. Do not retry.",
    );
  }
  return resolveInJail(root, path, action);
}

// read_file

export function buildReadFileTool(): ToolDefinition {
  return defineTool({
    name: "read_file",
    description:
      "Read a UTF-8 text file from the operator-mounted host folder, or list " +
      "a directory. Paths are root-relative (\"notes/todo.md\"), never " +
      "absolute — anything resolving outside the configured root is refused, " +
      "and symlinks are never followed. " +
      "A directory path returns `{kind:\"directory\", entries:[{name, kind, " +
      "sizeBytes?, modifiedAt?}]}` (directories first, capped, `truncated` " +
      "when cut). Start there to discover paths — there is no glob or " +
      "search. " +
      "A file returns `{kind:\"file\", content, startLine, endLine, " +
      "truncated}`. Files are read in LINES: by default the first 500. When " +
      "`truncated` is true, continue with a higher `offset` (e.g. " +
      "offset: 501). Large files stay reachable through those windows. " +
      "Read failures come back as `{ok:false, error, message}` with codes " +
      "ROOT_NOT_CONFIGURED, INVALID_PATH, PATH_ESCAPE, NOT_FOUND, " +
      "NOT_TEXT, READ_FAILED. " +
      "Binary or invalid-UTF-8 files are NOT_TEXT — do not retry them. " +
      "Read results are input to your work, not deliverables: quote only " +
      "what you need.",
    parameters: readFileArgsSchema,
    execute: async (args): Promise<ReadFileEnvelope> => {
      const { path, offset, limit } = args;
      const resolved = await jailResolve(path, "read");
      if (!resolved.ok) return resolved;

      let st: Stats;
      try {
        st = await stat(resolved.absPath);
      } catch {
        return err(
          "NOT_FOUND",
          `No such file or directory in the host folder: "${resolved.relPath}"`,
        );
      }

      if (st.isDirectory()) {
        try {
          return await listDirectory(resolved.absPath, resolved.relPath, st);
        } catch (e) {
          return err(
            "READ_FAILED",
            `Could not list "${resolved.relPath}": ${describeFsError(e)}`,
          );
        }
      }

      return readTextFile(
        resolved.absPath,
        resolved.relPath,
        st,
        offset ?? 1,
        limit ?? DEFAULT_READ_LIMIT_LINES,
      ).catch((e: unknown) =>
        err("READ_FAILED", `Could not read "${resolved.relPath}": ${describeFsError(e)}`),
      );
    },
  });
}

/**
 * Two read strategies share one envelope: whole-buffer for files inside
 * the byte budget (exact UTF-8 validation, exact line count), streaming
 * line-window for larger ones (never buffers the whole file).
 */
async function readTextFile(
  absPath: string,
  relPath: string,
  st: Stats,
  offset: number,
  limit: number,
): Promise<ReadFileEnvelope> {
  const maxBytes = readMaxBytes();

  if (st.size <= maxBytes) {
    const buf = await readFile(absPath);
    if (!isUtf8(buf)) {
      return err(
        "NOT_TEXT",
        `"${relPath}" is not valid UTF-8 text (${st.size} bytes). This tool ` +
          "handles text files only — do not retry.",
      );
    }
    const lines = normalizeLines(buf.toString("utf8"));
    const totalLines = lines.length;
    if (offset > totalLines + 1) {
      // Past EOF: an empty window is more useful than an error.
      return emptyWindow(relPath, st, offset);
    }
    const start = offset;
    const end = Math.min(start + limit - 1, totalLines);
    const window = lines.slice(start - 1, end);
    const result: ReadFileOk = {
      ok: true,
      kind: "file",
      path: relPath,
      content: window.join("\n"),
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      startLine: start,
      endLine: end,
      truncated: end < totalLines,
    };
    return result;
  }

  // Oversized path.
  const collected: string[] = [];
  let lineNo = 0;
  let bytes = 0;
  let sawReplacement = false;
  let reachedEnd = false;
  const stream = createReadStream(absPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < offset) continue;
      if (collected.length >= limit || bytes >= maxBytes) {
        reachedEnd = false;
        break;
      }
      if (line.includes("\uFFFD")) sawReplacement = true;
      bytes += line.length + 1;
      collected.push(line);
      reachedEnd = true;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (sawReplacement) {
    return err(
      "NOT_TEXT",
      `"${relPath}" does not decode as UTF-8 text. This tool handles text ` +
        "files only — do not retry.",
    );
  }
  if (collected.length === 0 && lineNo > 0 && offset > lineNo) {
    return emptyWindow(relPath, st, offset);
  }
  const result: ReadFileOk = {
    ok: true,
    kind: "file",
    path: relPath,
    content: collected.join("\n"),
    sizeBytes: st.size,
    modifiedAt: st.mtime.toISOString(),
    startLine: offset,
    endLine: offset + collected.length - 1,
    // The streaming path stops early, so anything short of a confirmed
    // end-of-readline means more lines may exist.
    truncated: !reachedEnd,
  };
  return result;
}

function emptyWindow(relPath: string, st: Stats, offset: number): ReadFileOk {
  return {
    ok: true,
    kind: "file",
    path: relPath,
    content: "",
    sizeBytes: st.size,
    modifiedAt: st.mtime.toISOString(),
    startLine: offset,
    endLine: offset - 1,
    truncated: false,
  };
}

async function listDirectory(
  absPath: string,
  relPath: string,
  st: Stats,
): Promise<ListDirOk> {
  const dirents = await readdir(absPath, { withFileTypes: true });
  // Symlinks and special files are dropped rather than listed: the jail
  // refuses to follow them, so surfacing them only invites retries.
  const usable = dirents
    .filter((d) => d.isFile() || d.isDirectory())
    .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  usable.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
  );

  const truncated = usable.length > MAX_LIST_ENTRIES;
  const page = truncated ? usable.slice(0, MAX_LIST_ENTRIES) : usable;

  const entries: DirListingEntry[] = [];
  for (const item of page) {
    let childStat: Stats | null = null;
    try {
      childStat = await stat(`${absPath}/${item.name}`);
    } catch {
      childStat = null;
    }
    entries.push({
      name: item.name,
      kind: item.isDir ? "directory" : "file",
      ...(childStat && !item.isDir ? { sizeBytes: childStat.size } : {}),
      ...(childStat ? { modifiedAt: childStat.mtime.toISOString() } : {}),
    });
  }

  return {
    ok: true,
    kind: "directory",
    // The root itself resolves to "" relative to itself; "." reads better.
    path: relPath === "" ? "." : relPath,
    modifiedAt: st.mtime.toISOString(),
    entries,
    truncated,
  };
}

// write_file

export function buildWriteFileTool(): ToolDefinition {
  return defineTool({
    name: "write_file",
    description:
      "Create or replace a UTF-8 text file inside the operator-mounted host " +
      "folder. Paths are root-relative (\"reports/digest.md\"); anything " +
      "resolving outside the root is refused, symlinks are never followed, " +
      "and the parent directory must already exist (read_file that " +
      "directory to see it). " +
      "`content` is the COMPLETE new file body — there is no append, patch " +
      "or partial-edit mode, so when changing an existing file read it " +
      "first and write back the whole result. Writes are atomic: a reader " +
      "never sees a half-written file. " +
      "There is NO delete, rename or move capability. To retire a file, " +
      "overwrite it with a short note that it is deprecated — never " +
      "assume a file is gone. " +
      "Failures return `{ok:false, error, message}`: TOO_LARGE (over the " +
      "byte budget), READ_ONLY_MOUNT (the folder is mounted read-only — " +
      "tell the user, do not retry), NOT_FOUND (missing parent), " +
      "IS_DIRECTORY, PATH_ESCAPE, WRITE_FAILED. This tool mutates the " +
      "user's real files; write only what the task requires.",
    parameters: writeFileArgsSchema,
    execute: async (args): Promise<WriteFileEnvelope> => {
      const { path, content } = args;
      const resolved = await jailResolve(path, "write");
      if (!resolved.ok) return resolved;

      const bytes = Buffer.byteLength(content, "utf8");
      const max = writeMaxBytes();
      if (bytes > max) {
        return err(
          "TOO_LARGE",
          `Content is ${bytes} bytes; the host-file write budget is ${max} ` +
            "(config `host.file.write_max_bytes`). Write a smaller file or " +
            "split the content.",
        );
      }

      let existedBefore = false;
      try {
        const st = await lstat(resolved.absPath);
        if (st.isDirectory()) {
          return err(
            "IS_DIRECTORY",
            `"${resolved.relPath}" is a directory. Provide a file path.`,
          );
        }
        existedBefore = true;
      } catch {
        existedBefore = false;
      }

      // Atomic replace: temp file in the SAME directory (rename across
      // filesystems is not atomic), then rename over the target.
      const tmpPath = `${resolved.absPath}.tmp-${randomUUID()}`;
      try {
        await writeFile(tmpPath, content, "utf8");
        try {
          await rename(tmpPath, resolved.absPath);
        } catch (e) {
          // QUIRK: on Windows, rename onto an existing file fails with
          // EPERM/EEXIST — POSIX replace semantics do not apply. Remove
          // the target and retry; the brief absence window is the cost of
          // a cross-platform replace.
          if (existedBefore && isRenameClobberError(e)) {
            await unlink(resolved.absPath).catch(() => {});
            await rename(tmpPath, resolved.absPath);
          } else {
            throw e;
          }
        }
      } catch (e) {
        await rm(tmpPath, { force: true }).catch(() => {});
        if (isReadOnlyError(e)) {
          return err(
            "READ_ONLY_MOUNT",
            `No write permission for "${resolved.relPath}" — the shared folder ` +
              "is mounted read-only. Tell the user rather than retrying: an " +
              "admin must drop the `:ro` flag from the shared_folder volume in " +
              "the container's mount config (and own the host directory as the " +
              "container user), or point `host.file.root` elsewhere.",
          );
        }
        return err(
          "WRITE_FAILED",
          `Could not write "${resolved.relPath}": ${describeFsError(e)}`,
        );
      }

      let st: Stats;
      try {
        st = await stat(resolved.absPath);
      } catch {
        return err("WRITE_FAILED", `Wrote "${resolved.relPath}" but could not verify it.`);
      }
      return {
        ok: true,
        path: resolved.relPath,
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        created: !existedBefore,
      };
    },
  });
}

// helpers

/** Normalize CRLF/CR to LF so line windows are stable for the LLM. */
function normalizeLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function describeFsError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isReadOnlyError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM";
}

function isRenameClobberError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EEXIST";
}
