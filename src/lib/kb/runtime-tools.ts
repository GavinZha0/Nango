/**
 * Server-side KB agent tools: `list_kb_pages` and `read_kb_page`.
 *
 * Auto-mounted when one or more `kb_collection` rows are bound to the agent —
 * not a user-tickable catalog entry. Both are read-only over operator-curated
 * content, so they ride the approval-exempt set. See docs/kb.md.
 */

import "server-only";

import { z } from "zod";

import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import type { KbContentType } from "@/lib/db/schema";
import { READ_MAX_BYTES } from "@/lib/kb/budgets";
import { MAX_PATH_CHARS } from "@/lib/kb/limits";
import { isUnderFolder } from "@/lib/kb/paths";
import {
  getKbPageByPath,
  listKbIndexPages,
  resolveKbCollectionForAgent,
  type KbIndexPage,
} from "@/lib/kb/lookup";

/**
 * CONTRACT: three codes and nothing else. `KB_NOT_AVAILABLE` covers unknown
 * slug, unbound collection and disabled collection as one indistinguishable
 * answer, and no failure returns the list of valid paths — `list_kb_pages` is
 * the discovery tool and an error path is not it (docs/kb.md).
 */
type KbToolError = "KB_NOT_AVAILABLE" | "NO_SUCH_PAGE" | "FOLDER_NOT_FOUND";

interface KbToolFailure {
  ok: false;
  error: KbToolError;
  message: string;
}

function fail(error: KbToolError, message: string): KbToolFailure {
  return { ok: false, error, message };
}

const KbNameArg = z
  .string()
  .min(1)
  .max(63)
  .describe(
    "Slug of the knowledge base, copied exactly from the `## Available knowledge` " +
      "block in your prompt. Do NOT pass a uuid, a folder path or a page title here.",
  );

const KbFolderArg = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .optional()
  .describe(
    "Optional. Return only the pages under this folder prefix instead of the whole " +
      "KB. Matched exactly and case-sensitively against the leading segments " +
      "of the paths in the index, and it covers every deeper folder below it, so " +
      "narrowing never hides content. A prefix that holds no page is not found.",
  );

// ──────────────────────── list_kb_pages ──────────────────────────

const ListKbPagesArgs = z.object({
  kb_name: KbNameArg,
  folder: KbFolderArg,
});

export interface ListKbPagesOk {
  ok: true;
  kbName: string;
  /** The collection's routing description, verbatim from the prompt block. */
  description: string | null;
  /** Echoed only when the view is a single folder's subtree. */
  folder?: string;
  /** Every page of the view, by full path, `alphabeticCompare` order. */
  pages: KbIndexPage[];
}

type ListKbPagesResult = ListKbPagesOk | KbToolFailure;

export function buildListKbPagesTool(opts: {
  agentKbCollectionIds: readonly string[];
}): ToolDefinition {
  const allowedIds = new Set(opts.agentKbCollectionIds);

  return defineTool({
    name: "list_kb_pages",
    description:
      "Show the pages of one knowledge base: each path with its one-line " +
      "summary. This is how you find the path to pass to read_kb_page — page " +
      "bodies are never returned here. Call it before guessing a path, and " +
      "again with `folder` if the KB is long.",
    parameters: ListKbPagesArgs,
    execute: async (args): Promise<ListKbPagesResult> => {
      const collection = await resolveKbCollectionForAgent(
        args.kb_name,
        allowedIds,
      );
      if (!collection) return notAvailable(args.kb_name);

      const pages = await listKbIndexPages(collection.id);

      if (args.folder === undefined) {
        return {
          ok: true,
          kbName: collection.name,
          description: collection.description,
          pages,
        };
      }

      const inside = pages.filter((page) => isUnderFolder(page.path, args.folder!));
      if (inside.length === 0) {
        return fail(
          "FOLDER_NOT_FOUND",
          `Knowledge base '${args.kb_name}' has no folder named ` +
            `'${args.folder}'. Folder names are the leading segments of the ` +
            "paths the `## Available knowledge` block shows; call list_kb_pages " +
            "without `folder` for the whole KB.",
        );
      }

      return {
        ok: true,
        kbName: collection.name,
        description: collection.description,
        folder: args.folder,
        pages: inside,
      };
    },
  });
}

// ──────────────────────── read_kb_page ───────────────────────────

const ReadKbPageArgs = z.object({
  kb_name: KbNameArg,
  page_path: z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .describe(
      "Exact page path as returned by list_kb_pages — case-sensitive, `/`-separated, " +
        "and not a title, a fragment or a folder. Paths are unique inside one " +
        "knowledge base, so this single string addresses the page.",
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based line number to start from. Default 1. Continue a truncated page " +
        "with the returned `nextOffset`.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      "Lines to return. Omitted means as many as fit the kb.read_max_bytes " +
        "budget. A window is still cut at the budget even with a large `limit`.",
    ),
});

export interface LineWindow {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  /** Line to pass as `offset` to continue; present only when `truncated`. */
  nextOffset?: number;
  /** Only when a single line was cut mid-line, so paging cannot recover it. */
  note?: string;
}

export interface ReadKbPageOk extends LineWindow {
  ok: true;
  kbName: string;
  pagePath: string;
  description: string | null;
  contentType: KbContentType;
}

type ReadKbPageResult = ReadKbPageOk | KbToolFailure;

export function buildReadKbPageTool(opts: {
  agentKbCollectionIds: readonly string[];
}): ToolDefinition {
  const allowedIds = new Set(opts.agentKbCollectionIds);

  return defineTool({
    name: "read_kb_page",
    description:
      "Read one page of a knowledge base, as text. Long pages come back in line " +
      "windows: check `truncated` and continue with `nextOffset` before " +
      "concluding a page says nothing about your question. Returns " +
      "`NO_SUCH_PAGE` for a path that is not in the index — get the exact path " +
      "from list_kb_pages instead of guessing again.",
    parameters: ReadKbPageArgs,
    execute: async (args): Promise<ReadKbPageResult> => {
      const collection = await resolveKbCollectionForAgent(
        args.kb_name,
        allowedIds,
      );
      if (!collection) return notAvailable(args.kb_name);

      const page = await getKbPageByPath(collection.id, args.page_path);
      if (!page) {
        return fail(
          "NO_SUCH_PAGE",
          `Knowledge base '${args.kb_name}' has no page at path ` +
            `'${args.page_path}'. Call list_kb_pages(kb_name: ` +
            `'${args.kb_name}') and pass a path from its index.`,
        );
      }

      const windowed = windowByLine(
        page.content,
        args.offset ?? 1,
        args.limit,
        READ_MAX_BYTES(),
      );

      return {
        ok: true,
        kbName: collection.name,
        pagePath: page.path,
        description: page.description,
        contentType: page.contentType,
        ...windowed,
      };
    },
  });
}

/**
 * Line-window a page body against a byte budget.
 *
 * Past `totalLines` an empty window is returned rather than an error, which is
 * what `read_file` does and what lets an agent probe the tail of a page without
 * a second call. There is no byte-offset mode: a KB page that only makes sense
 * as raw bytes should be re-imported formatted, not paged around (docs/kb.md).
 */
function windowByLine(
  content: string,
  offset: number,
  limit: number | undefined,
  maxBytes: number,
): LineWindow {
  const lines = splitLines(content);
  const totalLines = lines.length;

  if (offset > totalLines + 1) {
    return {
      content: "",
      startLine: offset,
      endLine: offset - 1,
      totalLines,
      truncated: false,
    };
  }

  const collected: string[] = [];
  let bytes = 0;
  let endLine = offset - 1;
  let midLine = false;

  for (let i = offset - 1; i < totalLines; i++) {
    if (limit !== undefined && collected.length >= limit) break;
    const room = maxBytes - bytes;
    if (room <= 0) break;
    const line = lines[i];
    // SECURITY: the budget is what keeps one tool result from flooding the
    // context, so one line longer than the remaining room is cut rather than
    // returned whole. `truncated` and `note` report the cut.
    const piece = cutToBytes(line, room);
    collected.push(piece);
    endLine = i + 1;
    bytes += Buffer.byteLength(piece, "utf8") + 1;
    midLine = piece !== line;
    if (midLine) break;
  }

  const truncated = endLine < totalLines || midLine;
  return {
    content: collected.join("\n"),
    startLine: offset,
    endLine,
    totalLines,
    truncated,
    ...(truncated ? { nextOffset: endLine + 1 } : {}),
    ...(midLine
      ? {
          note:
            `Line ${endLine} is longer than kb.read_max_bytes and was cut ` +
            "mid-line. Paging with offset returns the same head and never the " +
            "rest: re-import that page formatted (pretty-printed JSON, wrapped " +
            "text) rather than looping.",
        }
      : {}),
  };
}

/** Normalize to LF so line windows are stable for the LLM. */
function splitLines(content: string): string[] {
  if (content === "") return [];
  return content.replace(/\r\n?/g, "\n").split("\n");
}

/** Take the first `room` UTF-8 bytes, dropping a partial code point at the edge. */
function cutToBytes(text: string, room: number): string {
  if (Buffer.byteLength(text, "utf8") <= room) return text;
  const head = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  return head.endsWith("\uFFFD") ? head.slice(0, -1) : head;
}

function notAvailable(kbName: string): KbToolFailure {
  return fail(
    "KB_NOT_AVAILABLE",
    `No knowledge base named '${kbName}' is available to this agent — the ` +
      "slug is not bound here, or the KB is disabled. Use a slug from " +
      "the `## Available knowledge` block in your prompt.",
  );
}
