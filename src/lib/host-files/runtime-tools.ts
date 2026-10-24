/**
 * Server-side `read_file` / `write_file` / `edit_file` / `create_folder`
 * agent tools.
 *
 * All of them operate exclusively inside the operator-mounted root
 * configured by `host.file.root` (default `/shared_folder`, the
 * container-side of the compose bind mount). There is no availability
 * gate: a missing or mis-mounted root fails the call with
 * `ROOT_NOT_CONFIGURED` and the error message tells the agent which
 * mount to check.
 *
 * Scope: text files and directories. No delete, no rename, no move, no
 * glob. `write_file` replaces whole files or appends (`mode: "append"`);
 * `edit_file` changes a substring without a round trip through the whole
 * body. Binary payloads arrive through `download_file`, not here.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
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

import { describeFsError, isReadOnlyError, isRenameClobberError } from "./fs-error";
import { getHostFileRoot, resolveCreateInJail, resolveInJail } from "./jail.server";
import {
  createFolderArgsSchema,
  editFileArgsSchema,
  readFileArgsSchema,
  writeFileArgsSchema,
  type CreateFolderEnvelope,
  type DirListingEntry,
  type EditFileEnvelope,
  type EditFileError,
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

/**
 * The configured byte budget. A zero, negative or fractional value is a
 * mis-configuration rather than a mode, so it is floored to whole bytes with a
 * floor of 1: a read can always advance, and a byte window is never asked for
 * a negative `end`.
 */
function byteBudget(key: string): number {
  return Math.max(1, Math.floor(getConfigNumber(key, DEFAULT_MAX_BYTES)));
}

function readMaxBytes(): number {
  return byteBudget("host.file.read_max_bytes");
}

function writeMaxBytes(): number {
  return byteBudget("host.file.write_max_bytes");
}

/**
 * The configured root, or the refusal every host-file tool shares when
 * the operator has not mounted one.
 */
function requireHostFileRoot(): { ok: true; root: string } | HostFileErr {
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
  return { ok: true, root };
}

/**
 * Resolve the configured root and the jailed path, funneling every
 * pre-flight failure into the error envelope. Shared with
 * `download_file`, which needs the same containment rules before it
 * spends a network request.
 */
export async function jailResolve(
  path: string,
  action: "read" | "write",
): Promise<{ ok: true; absPath: string; relPath: string } | HostFileErr> {
  const root = requireHostFileRoot();
  if (!root.ok) return root;
  return resolveInJail(root.root, path, action);
}

/** Same, for `create_folder`: missing parents are the expected case. */
async function folderResolve(
  path: string,
): Promise<{ ok: true; absPath: string; relPath: string } | HostFileErr> {
  const root = requireHostFileRoot();
  if (!root.ok) return root;
  return resolveCreateInJail(root.root, path);
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
      "sizeBytes?, modifiedAt?}], startEntry, endEntry, truncated}` " +
      "(directories first, 500 entries per page). Start there to discover " +
      "paths — there is no glob or search. " +
      "A file returns `{kind:\"file\", content, startLine, endLine, " +
      "truncated}`. Files are read in LINES: by default the first 500. When " +
      "`truncated` is true, continue with a higher `offset` (e.g. " +
      "offset: 501) — the same argument pages a directory listing. Large " +
      "files stay reachable through those windows, but a window cannot " +
      "resume inside a line: a single line longer than the byte budget is " +
      "cut and the rest of that line only comes back with `raw: true`. " +
      "`raw: true` reads the file exactly as stored — no line splitting, no " +
      "line-ending normalization — and pages by BYTE: `offset` is a byte " +
      "position, `limit` is ignored, and you continue with the returned " +
      "`nextByteOffset` until `truncated` is false. Use it for byte-faithful " +
      "comparison (is this file CRLF?) and to reach what a line window cut. " +
      "Read failures come back as `{ok:false, error, message}` with codes " +
      "ROOT_NOT_CONFIGURED, INVALID_PATH, PATH_ESCAPE, NOT_FOUND, " +
      "NOT_TEXT, READ_FAILED. " +
      "Binary or invalid-UTF-8 files are NOT_TEXT — do not retry them. " +
      "Read results are input to your work, not deliverables: quote only " +
      "what you need.",
    parameters: readFileArgsSchema,
    execute: async (args): Promise<ReadFileEnvelope> => {
      const { path, offset, limit, raw } = args;
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
          return await listDirectory(
            resolved.absPath,
            resolved.relPath,
            st,
            offset ?? 1,
            limit ?? MAX_LIST_ENTRIES,
          );
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
        raw ?? false,
      ).catch((e: unknown) =>
        err("READ_FAILED", `Could not read "${resolved.relPath}": ${describeFsError(e)}`),
      );
    },
  });
}

/**
 * Three read strategies share one envelope: a byte window for `raw: true`
 * (verbatim, resumable through `nextByteOffset`), whole-buffer line windows
 * for files inside the budget (exact UTF-8 validation, exact line count),
 * and a streaming line-window for larger ones (never buffers the whole
 * file).
 */
async function readTextFile(
  absPath: string,
  relPath: string,
  st: Stats,
  offset: number,
  limit: number,
  raw: boolean,
): Promise<ReadFileEnvelope> {
  const maxBytes = readMaxBytes();

  if (raw) return readRawFile(absPath, relPath, st, maxBytes, offset);

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
      // SECURITY: the byte budget is what keeps one tool result from
      // flooding the context, so a single line longer than the remaining
      // budget is cut rather than returned whole. `truncated` reports it.
      const room = maxBytes - bytes;
      const piece = line.length > room ? line.slice(0, room) : line;
      bytes += piece.length + 1;
      collected.push(piece);
      reachedEnd = piece.length === line.length;
      if (!reachedEnd) break;
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

/**
 * `raw: true` — the file exactly as stored: no line splitting, no
 * CRLF→LF normalization, no line windowing. `offset` is the 1-based byte
 * position, so a window cut by the byte budget is always resumable, and a
 * cut never drops a partial character.
 */
async function readRawFile(
  absPath: string,
  relPath: string,
  st: Stats,
  maxBytes: number,
  offset: number,
): Promise<ReadFileEnvelope> {
  const start = offset - 1;
  if (start >= st.size) {
    // Past EOF: an empty window is more useful than an error.
    return {
      ok: true,
      kind: "file",
      path: relPath,
      content: "",
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      truncated: false,
    };
  }

  let buf = await readWindow(absPath, start, Math.min(maxBytes, st.size - start));
  const truncated = start + buf.length < st.size;

  if (!isUtf8(buf) && truncated) {
    // The cut landed inside a multi-byte character; drop up to three
    // trailing bytes rather than reporting a text file as binary.
    const whole = buf;
    for (let drop = 1; drop <= 3; drop++) {
      const candidate = whole.subarray(0, whole.length - drop);
      if (isUtf8(candidate)) {
        buf = candidate;
        break;
      }
    }
  }
  if (!isUtf8(buf)) {
    return err(
      "NOT_TEXT",
      `"${relPath}" is not valid UTF-8 text (${st.size} bytes). This tool ` +
        "handles text files only — do not retry.",
    );
  }

  return {
    ok: true,
    kind: "file",
    path: relPath,
    content: buf.toString("utf8"),
    sizeBytes: st.size,
    modifiedAt: st.mtime.toISOString(),
    // CONTRACT: this lands on a character boundary, so paging from it never
    // re-reads or skips a byte.
    ...(truncated ? { nextByteOffset: start + buf.length + 1 } : {}),
    truncated,
  };
}

/** Stream `bytes` from `start` without buffering the rest of the file. */
async function readWindow(
  absPath: string,
  start: number,
  bytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = createReadStream(absPath, { start, end: start + bytes - 1 });
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

async function listDirectory(
  absPath: string,
  relPath: string,
  st: Stats,
  offset: number,
  limit: number,
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

  const first = offset - 1;
  const pageSize = Math.min(limit, MAX_LIST_ENTRIES);
  const page = usable.slice(first, first + pageSize);
  const truncated = first + page.length < usable.length;

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
    startEntry: offset,
    endEntry: offset + page.length - 1,
    truncated,
  };
}

// write_file

export function buildWriteFileTool(): ToolDefinition {
  return defineTool({
    name: "write_file",
    description:
      "Create, replace, or extend a UTF-8 text file inside the " +
      "operator-mounted host folder. Paths are root-relative " +
      "(\"reports/digest.md\"); anything resolving outside the root is " +
      "refused, symlinks are never followed, and the parent directory must " +
      "already exist (create it with `create_folder`). " +
      "By default `content` is the COMPLETE new file body and replaces the " +
      "file atomically, so when changing an existing file read it first and " +
      "write back the whole result — or change one substring with " +
      "`edit_file`. `mode: \"append\"` adds `content` at the end without " +
      "rewriting, which keeps a growing log writable even when the file is " +
      "bigger than the write budget; append is not atomic, so an interrupted " +
      "call can leave a partial line. " +
      "There is NO delete, rename or move capability. To retire a file, " +
      "overwrite it with a short note that it is deprecated — never " +
      "assume a file is gone. " +
      "Failures return `{ok:false, error, message}`: ROOT_NOT_CONFIGURED, " +
      "INVALID_PATH, PATH_ESCAPE, TOO_LARGE (payload over " +
      "the byte budget), READ_ONLY_MOUNT (the folder is mounted read-only — " +
      "tell the user, do not retry), NOT_FOUND (missing parent), " +
      "IS_DIRECTORY, WRITE_FAILED. This tool mutates the " +
      "user's real files; write only what the task requires.",
    parameters: writeFileArgsSchema,
    execute: async (args): Promise<WriteFileEnvelope> => {
      const { path, content, mode = "overwrite" } = args;
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

      try {
        if (mode === "append") {
          await appendFile(resolved.absPath, content, "utf8");
        } else {
          await atomicReplace(resolved.absPath, content, existedBefore);
        }
      } catch (e) {
        return writeFailure(resolved.relPath, mode === "append" ? "append to" : "write", e);
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

// edit_file

export function buildEditFileTool(): ToolDefinition {
  return defineTool({
    name: "edit_file",
    description:
      "Replace text inside an existing UTF-8 file in the operator-mounted " +
      "host folder, without writing the whole body back. Paths are " +
      "root-relative and jailed exactly like write_file. " +
      "`old_string` must be copied verbatim from read_file and match " +
      "exactly one place: zero matches is NOT_IN_FILE, several are " +
      "NOT_UNIQUE (re-count them and widen the snippet with surrounding " +
      "context, or set `replace_all`). An empty `new_string` deletes the " +
      "match. " +
      "The whole file is read, edited and atomically replaced, so it has to " +
      "fit the read budget. Only the matched span is rewritten: every other " +
      "byte keeps the ending it was stored with, and a snippet copied from " +
      "read_file also matches a CRLF file. " +
      "There is NO delete, rename or move capability, and this cannot " +
      "create a file: use write_file. " +
      "Failures return `{ok:false, error, message}`: NOT_IN_FILE, NOT_UNIQUE, " +
      "ROOT_NOT_CONFIGURED, INVALID_PATH, PATH_ESCAPE, TOO_LARGE, " +
      "READ_ONLY_MOUNT, NOT_FOUND, IS_DIRECTORY, NOT_TEXT, READ_FAILED, " +
      "WRITE_FAILED.",
    parameters: editFileArgsSchema,
    execute: async (args): Promise<EditFileEnvelope> => {
      const { path, old_string, new_string, replace_all = false } = args;
      const resolved = await jailResolve(path, "write");
      if (!resolved.ok) return resolved;

      let st: Stats;
      try {
        st = await lstat(resolved.absPath);
      } catch {
        return editErr(
          "NOT_FOUND",
          `"${resolved.relPath}" does not exist. edit_file only edits ` +
            "existing files — create it with write_file.",
        );
      }
      if (st.isDirectory()) {
        return editErr(
          "IS_DIRECTORY",
          `"${resolved.relPath}" is a directory. Provide a file path.`,
        );
      }

      const max = readMaxBytes();
      if (st.size > max) {
        return editErr(
          "TOO_LARGE",
          `The file is ${st.size} bytes; edit_file reads and rewrites the ` +
            `whole file, capped at ${max} (config ` +
            "`host.file.read_max_bytes`). Ask the user to raise it, or split " +
            "the file — there is no way to edit bytes past that cap.",
        );
      }

      let buf: Buffer;
      try {
        buf = await readFile(resolved.absPath);
      } catch (e) {
        return editErr(
          "READ_FAILED",
          `Could not read "${resolved.relPath}": ${describeFsError(e)}`,
        );
      }
      if (!isUtf8(buf)) {
        return editErr(
          "NOT_TEXT",
          `"${resolved.relPath}" is not valid UTF-8 text (${st.size} bytes). ` +
            "This tool handles text files only — do not retry.",
        );
      }

      // QUIRK: read_file shows LF, so a snippet pasted from a CRLF file
      // arrives LF. Matching on file bytes in each spelling keeps the
      // rewrite inside the matched span — normalizing the whole file and
      // restoring its endings afterwards would rewrite every line the edit
      // never touched in a mixed-ending file.
      const text = buf.toString("utf8");
      const chosen = pickMatch(text, old_string, new_string);
      if (!chosen) {
        return editErr(
          "NOT_IN_FILE",
          `"${old_string.slice(0, 80)}" was not found in ` +
            `"${resolved.relPath}". Copy the exact text from read_file — ` +
            "indentation and line breaks must match. If the file mixes line " +
            "endings, compare it with read_file using raw: true.",
        );
      }
      if (chosen.matches > 1 && !replace_all) {
        return editErr(
          "NOT_UNIQUE",
          `"${chosen.needle.slice(0, 80)}" matches ${chosen.matches} places in ` +
            `"${resolved.relPath}". Widen the snippet with surrounding ` +
            "context, or set replace_all to replace every occurrence.",
        );
      }

      const edited = text.split(chosen.needle).join(chosen.replacement);
      const outBytes = Buffer.byteLength(edited, "utf8");
      if (outBytes > writeMaxBytes()) {
        return editErr(
          "TOO_LARGE",
          `The edited file would be ${outBytes} bytes; the host-file write ` +
            `budget is ${writeMaxBytes()} (config \`host.file.write_max_bytes\`).`,
        );
      }

      try {
        await atomicReplace(resolved.absPath, edited, true);
      } catch (e) {
        return writeFailure(resolved.relPath, "write", e);
      }

      let after: Stats;
      try {
        after = await stat(resolved.absPath);
      } catch {
        return editErr(
          "WRITE_FAILED",
          `Edited "${resolved.relPath}" but could not verify it.`,
        );
      }
      return {
        ok: true,
        path: resolved.relPath,
        replacements: replace_all ? chosen.matches : 1,
        sizeBytes: after.size,
        modifiedAt: after.mtime.toISOString(),
      };
    },
  });
}

// create_folder

export function buildCreateFolderTool(): ToolDefinition {
  return defineTool({
    name: "create_folder",
    description:
      "Create a directory inside the mounted host folder, including any " +
      "missing parents. Paths are root-relative (\"inbox/debian\") and are " +
      "confined by the same jail as write_file: absolute or drive-lettered " +
      "input is re-rooted into the mount, `..` cannot escape, and a " +
      "symlinked component is refused (PATH_ESCAPE). " +
      "An already existing directory returns `{ok:true, created:false}` — " +
      "that is success, so calling it again is safe. A regular file with " +
      "the same name is IS_FILE: there is no delete or rename, so pick a " +
      "different name instead of retrying. " +
      "There is NO delete, rename or move for directories either; a " +
      "directory you no longer need stays visible to the user. " +
      "Failures return `{ok:false, error, message}`: ROOT_NOT_CONFIGURED, " +
      "INVALID_PATH, PATH_ESCAPE, IS_FILE, READ_ONLY_MOUNT, WRITE_FAILED. " +
      "Use this before write_file or download_file when the destination " +
      "directory does not exist yet.",
    parameters: createFolderArgsSchema,
    execute: async (args): Promise<CreateFolderEnvelope> => {
      const resolved = await folderResolve(args.path);
      if (!resolved.ok) return resolved;

      // Root addressed as itself — nothing to create, and reporting it as
      // created would imply the agent can mint the mount.
      const displayPath = resolved.relPath === "" ? "." : resolved.relPath;
      if (resolved.relPath === "") {
        return { ok: true, path: displayPath, created: false };
      }

      try {
        const st = await lstat(resolved.absPath);
        if (st.isDirectory()) {
          return { ok: true, path: displayPath, created: false };
        }
        return err(
          "IS_FILE",
          `"${displayPath}" is occupied by something that is not a ` +
            "directory. There is no delete or rename capability — choose a " +
            "different name.",
        );
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          return err(
            "WRITE_FAILED",
            `Could not inspect "${displayPath}": ${describeFsError(e)}`,
          );
        }
      }

      try {
        await mkdir(resolved.absPath, { recursive: true });
      } catch (e) {
        if (isReadOnlyError(e)) {
          return err(
            "READ_ONLY_MOUNT",
            `No write permission to create "${displayPath}" — the shared ` +
              "folder is mounted read-only. Tell the user rather than " +
              "retrying.",
          );
        }
        // A racing mkdir -p under the same path is a success, not an error.
        if ((e as { code?: string } | null)?.code === "EEXIST") {
          return { ok: true, path: displayPath, created: false };
        }
        return err(
          "WRITE_FAILED",
          `Could not create "${displayPath}": ${describeFsError(e)}`,
        );
      }

      return { ok: true, path: displayPath, created: true };
    },
  });
}

// helpers

/** The two line-ending spellings a snippet can arrive in. */
const asLf = (text: string): string => text.replace(/\r\n?/g, "\n");
const asCrlf = (text: string): string => asLf(text).replace(/\n/g, "\r\n");

/** Normalize to LF so line windows are stable for the LLM. */
function normalizeLines(text: string): string[] {
  if (text === "") return [];
  return asLf(text).split("\n");
}

/**
 * The snippet an agent pastes can disagree with the file on line endings,
 * because `read_file` shows LF. Each spelling is tried against the file as
 * stored; the first that matches decides the edit, and only the matched
 * span is rewritten — the bytes around it keep whatever endings they had.
 */
function matchVariants(
  oldString: string,
  newString: string,
): Array<{ needle: string; replacement: string }> {
  const variants: Array<{ needle: string; replacement: string }> = [];
  for (const [needle, replacement] of [
    [oldString, newString],
    [asCrlf(oldString), asCrlf(newString)],
    [asLf(oldString), asLf(newString)],
  ] as Array<[string, string]>) {
    if (!variants.some((v) => v.needle === needle)) variants.push({ needle, replacement });
  }
  return variants;
}

/** The first spelling of `old_string` present in the file, with its count. */
function pickMatch(
  text: string,
  oldString: string,
  newString: string,
): { needle: string; replacement: string; matches: number } | null {
  for (const variant of matchVariants(oldString, newString)) {
    const matches = text.split(variant.needle).length - 1;
    if (matches > 0) return { ...variant, matches };
  }
  return null;
}

/**
 * Atomic whole-file replace: temp file in the SAME directory (rename across
 * filesystems is not atomic), then rename over the target. Shared by
 * `write_file` and `edit_file`.
 */
async function atomicReplace(
  absPath: string,
  content: string,
  existedBefore: boolean,
): Promise<void> {
  const tmpPath = `${absPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, content, "utf8");
    try {
      await rename(tmpPath, absPath);
    } catch (e) {
      // QUIRK: on Windows, rename onto an existing file fails with
      // EPERM/EEXIST — POSIX replace semantics do not apply. Remove
      // the target and retry; the brief absence window is the cost of
      // a cross-platform replace.
      if (existedBefore && isRenameClobberError(e)) {
        await unlink(absPath).catch(() => {});
        await rename(tmpPath, absPath);
      } else {
        throw e;
      }
    }
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }
}

/** The refusal every write-side tool shares when the mount says no. */
function readOnlyMount(relPath: string): HostFileErr {
  return err(
    "READ_ONLY_MOUNT",
    `No write permission for "${relPath}" — the shared folder is mounted ` +
      "read-only. Tell the user rather than retrying: an admin must drop " +
      "the `:ro` flag from the shared_folder volume in the container's " +
      "mount config (and own the host directory as the container user), or " +
      "point `host.file.root` elsewhere.",
  );
}

function writeFailure(relPath: string, verb: string, e: unknown): HostFileErr {
  if (isReadOnlyError(e)) return readOnlyMount(relPath);
  return err(
    "WRITE_FAILED",
    `Could not ${verb} "${relPath}": ${describeFsError(e)}`,
  );
}

function editErr(error: EditFileError, message: string): EditFileEnvelope {
  return { ok: false, error, message };
}
