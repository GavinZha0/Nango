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
import { MAX_LABEL_CHARS } from "@/lib/kb/limits";
import {
  getKbIndex,
  getKbPageByName,
  resolveKbCollectionForAgent,
  type KbIndexGroup,
  type KbIndexPage,
} from "@/lib/kb/lookup";

/**
 * CONTRACT: three codes and nothing else. `KB_NOT_AVAILABLE` covers unknown
 * slug, unbound collection and disabled collection as one indistinguishable
 * answer, and no failure returns the list of valid names — `list_kb_pages` is
 * the discovery tool and an error path is not it (docs/kb.md).
 */
type KbToolError = "KB_NOT_AVAILABLE" | "NO_SUCH_PAGE" | "GROUP_NOT_FOUND";

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
      "block in your prompt. Do NOT pass a uuid, a group name or a page title here.",
  );

const KbGroupNameArg = z
  .string()
  .min(1)
  .max(MAX_LABEL_CHARS)
  .optional()
  .describe(
    "Optional. Return one group and its child groups instead of the whole index. " +
      "Matched exactly and case-sensitively against the group names in the block; " +
      "a level-1 group includes its level-2 children, so narrowing to it never " +
      "hides content. Pages that sit in no group are not addressable here — read " +
      "those by page name.",
  );

// ──────────────────────── list_kb_pages ──────────────────────────

const ListKbPagesArgs = z.object({
  kb_name: KbNameArg,
  group_name: KbGroupNameArg,
});

export interface ListKbPagesOk {
  ok: true;
  kbName: string;
  /** The collection's routing description, verbatim from the prompt block. */
  description: string | null;
  /** Echoed only when the view is a single group's subtree. */
  groupName?: string;
  /** Level-1 groups each followed by their children, both alphabetically. */
  groups: KbIndexGroup[];
  /** Pages with no group. Empty in a `group_name` view. */
  ungroupedPages: KbIndexPage[];
}

type ListKbPagesResult = ListKbPagesOk | KbToolFailure;

export function buildListKbPagesTool(opts: {
  agentKbCollectionIds: readonly string[];
}): ToolDefinition {
  const allowedIds = new Set(opts.agentKbCollectionIds);

  return defineTool({
    name: "list_kb_pages",
    description:
      "Show the index of one knowledge base: every group with its description " +
      "and page count, and every page with its name and one-line summary. This " +
      "is how you find a page name to pass to read_kb_page — page bodies are " +
      "never returned here. Call it before guessing a page name, and again with " +
      "`group_name` if the index is long.",
    parameters: ListKbPagesArgs,
    execute: async (args): Promise<ListKbPagesResult> => {
      const collection = await resolveKbCollectionForAgent(
        args.kb_name,
        allowedIds,
      );
      if (!collection) return notAvailable(args.kb_name);

      const index = await getKbIndex(collection.id);

      if (args.group_name === undefined) {
        return {
          ok: true,
          kbName: collection.name,
          description: collection.description,
          groups: index.groups,
          ungroupedPages: index.ungroupedPages,
        };
      }

      const group = index.groups.find((g) => g.name === args.group_name);
      if (!group) {
        return fail(
          "GROUP_NOT_FOUND",
          `Knowledge base '${args.kb_name}' has no group named ` +
            `'${args.group_name}'. Group names are exactly as the ` +
            "`## Available knowledge` block shows them; call list_kb_pages " +
            "without `group_name` for the full index.",
        );
      }

      return {
        ok: true,
        kbName: collection.name,
        description: collection.description,
        groupName: group.name,
        groups: index.groups.filter(
          (g) => g.name === group.name || g.parentName === group.name,
        ),
        ungroupedPages: [],
      };
    },
  });
}

// ──────────────────────── read_kb_page ───────────────────────────

const ReadKbPageArgs = z.object({
  kb_name: KbNameArg,
  page_name: z
    .string()
    .min(1)
    .max(MAX_LABEL_CHARS)
    .describe(
      "Exact page name as returned by list_kb_pages — case-sensitive, and not a " +
        "title, a fragment or a group name. Page names are unique inside one " +
        "knowledge base, so you do not need to know which group holds it.",
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
  pageName: string;
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
      "`NO_SUCH_PAGE` for a name that is not in the index — get the exact name " +
      "from list_kb_pages instead of guessing again.",
    parameters: ReadKbPageArgs,
    execute: async (args): Promise<ReadKbPageResult> => {
      const collection = await resolveKbCollectionForAgent(
        args.kb_name,
        allowedIds,
      );
      if (!collection) return notAvailable(args.kb_name);

      const page = await getKbPageByName(collection.id, args.page_name);
      if (!page) {
        return fail(
          "NO_SUCH_PAGE",
          `Knowledge base '${args.kb_name}' has no page named ` +
            `'${args.page_name}'. Call list_kb_pages(kb_name: ` +
            `'${args.kb_name}') and pass a name from its index.`,
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
        pageName: page.name,
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
      "slug is not bound here, or the collection is disabled. Use a slug from " +
      "the `## Available knowledge` block in your prompt.",
  );
}
