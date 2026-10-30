import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig: Record<string, string> = {};
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: (key: string, defaultValue: string) => mockConfig[key] ?? defaultValue,
    getConfigNumber: (key: string, defaultValue: number) => {
      const raw = mockConfig[key];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    },
  };
});

const mockResolve = vi.fn();
const mockIndexPages = vi.fn();
const mockGetPage = vi.fn();
vi.mock("@/lib/kb/lookup", () => ({
  resolveKbCollectionForAgent: (name: string, ids: ReadonlySet<string>) =>
    mockResolve(name, ids),
  listKbIndexPages: (id: string) => mockIndexPages(id),
  getKbPageByPath: (id: string, path: string) => mockGetPage(id, path),
}));

import {
  buildListKbPagesTool,
  buildReadKbPageTool,
  type ListKbPagesOk,
  type ReadKbPageOk,
} from "@/lib/kb/runtime-tools";
import type { KbIndexPage } from "@/lib/kb/lookup";

const COLLECTION_ID = "11111111-1111-1111-1111-111111111111";
const BOUND = [COLLECTION_ID];

type Failure = { ok: false; error: string; message: string };

function bound(name = "x-manual"): void {
  mockResolve.mockResolvedValue({ id: COLLECTION_ID, name, description: "Manual." });
}

/** The whole collection's index: paths only, exactly as `lookup` derives them. */
function indexPages(): KbIndexPage[] {
  return [
    { path: "chapter-01/bare-metal", description: "Bare-metal path." },
    { path: "chapter-01/images/build", description: null },
    { path: "chapter-02/config", description: "Config." },
    { path: "loose-note", description: null },
  ];
}

function page(content: string, overrides: Record<string, unknown> = {}): void {
  mockGetPage.mockResolvedValue({
    path: "chapter-01/bare-metal",
    description: "Bare-metal path.",
    content,
    contentType: "text/markdown",
    ...overrides,
  });
}

async function read(args: {
  page_path: string;
  kb_name?: string;
  offset?: number;
  limit?: number;
}): Promise<ReadKbPageOk | Failure> {
  const tool = buildReadKbPageTool({ agentKbCollectionIds: BOUND });
  return (await tool.execute!({ kb_name: "x-manual", ...args })) as
    ReadKbPageOk | Failure;
}

async function list(args: {
  kb_name?: string;
  folder?: string;
}): Promise<ListKbPagesOk | Failure> {
  const tool = buildListKbPagesTool({ agentKbCollectionIds: BOUND });
  return (await tool.execute!({ kb_name: "x-manual", ...args })) as
    ListKbPagesOk | Failure;
}

beforeEach(() => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  mockResolve.mockReset();
  mockIndexPages.mockReset();
  mockGetPage.mockReset();
});

describe("list_kb_pages", () => {
  it("returns the derived index for an unqualified call", async () => {
    bound();
    mockIndexPages.mockResolvedValue(indexPages());

    const result = await list({});

    expect(result.ok).toBe(true);
    const ok = result as ListKbPagesOk;
    expect(ok.kbName).toBe("x-manual");
    expect(ok.description).toBe("Manual.");
    expect(ok.folder).toBeUndefined();
    expect(ok.pages.map((p) => p.path)).toEqual([
      "chapter-01/bare-metal",
      "chapter-01/images/build",
      "chapter-02/config",
      "loose-note",
    ]);
    // Page bodies never travel on this surface.
    expect(ok.pages[0]).toEqual({
      path: "chapter-01/bare-metal",
      description: "Bare-metal path.",
    });
  });

  it("narrows to a folder subtree, deeper folders included, and echoes the scope", async () => {
    bound();
    mockIndexPages.mockResolvedValue(indexPages());

    const ok = (await list({ folder: "chapter-01" })) as ListKbPagesOk;

    expect(ok.folder).toBe("chapter-01");
    expect(ok.pages.map((p) => p.path)).toEqual([
      "chapter-01/bare-metal",
      "chapter-01/images/build",
    ]);
  });

  it("matches a nested prefix exactly, so a look-alike name is not a subtree", async () => {
    bound();
    mockIndexPages.mockResolvedValue(indexPages());

    const failure = (await list({ folder: "chapter-01-images" })) as Failure;
    expect(failure.error).toBe("FOLDER_NOT_FOUND");

    const ok = (await list({ folder: "chapter-01/images" })) as ListKbPagesOk;
    expect(ok.pages.map((p) => p.path)).toEqual(["chapter-01/images/build"]);
  });

  it("reports a miss without a candidate list, so the index stays the only discovery channel", async () => {
    bound();
    mockIndexPages.mockResolvedValue(indexPages());

    const failure = (await list({ folder: "Chapter-01" })) as Failure;

    expect(failure).toEqual({
      ok: false,
      error: "FOLDER_NOT_FOUND",
      message: expect.any(String),
    });
    expect(failure.message).not.toContain("bare-metal");
  });

  it("folds an unbound slug and a disabled collection into one KB_NOT_AVAILABLE", async () => {
    mockResolve.mockResolvedValue(null);

    expect(await list({ kb_name: "not-mine" })).toEqual({
      ok: false,
      error: "KB_NOT_AVAILABLE",
      message: expect.any(String),
    });
    // The message must not enumerate what *is* bound.
    expect(mockResolve).toHaveBeenCalledWith("not-mine", new Set(BOUND));
  });

  it("never reads the index for a collection the agent cannot resolve", async () => {
    mockResolve.mockResolvedValue(null);
    await list({});
    expect(mockIndexPages).not.toHaveBeenCalled();
  });
});

describe("read_kb_page", () => {
  it("returns a short page whole, unflagged", async () => {
    bound();
    page("line one\nline two");

    const ok = (await read({ page_path: "chapter-01/bare-metal" })) as ReadKbPageOk;

    expect(ok).toMatchObject({
      ok: true,
      kbName: "x-manual",
      pagePath: "chapter-01/bare-metal",
      contentType: "text/markdown",
      content: "line one\nline two",
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      truncated: false,
    });
    expect(ok.nextOffset).toBeUndefined();
    expect(ok.note).toBeUndefined();
  });

  it("normalises CRLF and lone CR to LF so windows stay stable", async () => {
    bound();
    page("a\r\nb\rc");

    const ok = (await read({ page_path: "chapter-01/bare-metal" })) as ReadKbPageOk;
    expect(ok.content).toBe("a\nb\nc");
    expect(ok.totalLines).toBe(3);
  });

  it("cuts at the byte budget and points at the continuation line", async () => {
    bound();
    mockConfig["kb.read_max_bytes"] = "8";
    page("aaa\nbbb\nccc");

    const ok = (await read({ page_path: "chapter-01/bare-metal" })) as ReadKbPageOk;

    expect(ok.content).toBe("aaa\nbbb");
    expect(ok.truncated).toBe(true);
    expect(ok.nextOffset).toBe(3);
    // Paging recovers the rest.
    const tail = (await read({
      page_path: "chapter-01/bare-metal",
      offset: 3,
    })) as ReadKbPageOk;
    expect(tail.content).toBe("ccc");
    expect(tail.truncated).toBe(false);
  });

  it("floors a zero or negative budget at 1 byte so paging keeps advancing", async () => {
    bound();
    page("aaa\nbbb\nccc");

    for (const misconfiguration of ["0", "-5", "0.4"]) {
      mockConfig["kb.read_max_bytes"] = misconfiguration;

      const ok = (await read({ page_path: "chapter-01/bare-metal" })) as ReadKbPageOk;

      // Without the floor the loop breaks before consuming a line and
      // `nextOffset` equals the requested `offset` — the agent pages in place
      // forever on an empty window.
      expect(ok.content).toBe("a");
      expect(ok.endLine).toBe(1);
      expect(ok.nextOffset).toBe(2);
    }
  });

  it("byte-caps a single long line and tells the author to re-format instead of looping", async () => {
    bound();
    mockConfig["kb.read_max_bytes"] = "10";
    page("aaaaaaaaaaaaaaaaaaaa\nsecond");

    const ok = (await read({ page_path: "chapter-01/bare-metal" })) as ReadKbPageOk;

    expect(ok.content).toBe("aaaaaaaaaa");
    expect(ok.truncated).toBe(true);
    expect(ok.note).toContain("re-import");
    // Paging cannot recover what a line window has no boundary to cut at.
    const again = (await read({
      page_path: "chapter-01/bare-metal",
      offset: ok.nextOffset,
    })) as ReadKbPageOk;
    expect(again.content).toBe("second");
  });

  it("drops a partial code point at the budget edge instead of emitting U+FFFD", async () => {
    bound();
    mockConfig["kb.read_max_bytes"] = "4";
    page("知识知识");

    const ok = (await read({ page_path: "chapter-01/bare-metal" })) as ReadKbPageOk;

    expect(ok.content).toBe("知");
    expect(ok.content).not.toContain(String.fromCharCode(0xfffd));
    expect(Buffer.byteLength(ok.content, "utf8")).toBe(3);
  });

  it("honours `limit` but the budget still wins when it is tighter", async () => {
    bound();
    mockConfig["kb.read_max_bytes"] = "64";
    page("a\nb\nc\nd\ne");

    const windowed = (await read({
      page_path: "chapter-01/bare-metal",
      limit: 2,
    })) as ReadKbPageOk;
    expect(windowed.content).toBe("a\nb");
    expect(windowed.endLine).toBe(2);
    expect(windowed.totalLines).toBe(5);
    expect(windowed.truncated).toBe(true);
    expect(windowed.note).toBeUndefined();

    mockConfig["kb.read_max_bytes"] = "4";
    const cut = (await read({
      page_path: "chapter-01/bare-metal",
      limit: 5000,
    })) as ReadKbPageOk;
    expect(cut.content).toBe("a\nb");
    expect(cut.truncated).toBe(true);
  });

  it("answers an out-of-range offset with an empty window, not an error", async () => {
    bound();
    page("a\nb");

    const ok = (await read({
      page_path: "chapter-01/bare-metal",
      offset: 99,
    })) as ReadKbPageOk;

    expect(ok).toMatchObject({
      ok: true,
      content: "",
      startLine: 99,
      endLine: 98,
      totalLines: 2,
      truncated: false,
    });
    expect(ok.nextOffset).toBeUndefined();
  });

  it("returns NO_SUCH_PAGE with nothing but the reason", async () => {
    bound();
    mockGetPage.mockResolvedValue(null);

    const failure = (await read({ page_path: "Chapter-01/Bare-Metal" })) as Failure;

    expect(Object.keys(failure).sort()).toEqual(["error", "message", "ok"]);
    expect(failure.error).toBe("NO_SUCH_PAGE");
    // The path it was given is the only path named — the index is the list.
    expect(mockGetPage).toHaveBeenCalledWith(
      COLLECTION_ID,
      "Chapter-01/Bare-Metal",
    );
  });

  it("treats a folder prefix as a page miss, never as a subtree read", async () => {
    bound();
    mockGetPage.mockResolvedValue(null);

    const failure = (await read({ page_path: "chapter-01" })) as Failure;

    expect(failure.error).toBe("NO_SUCH_PAGE");
    expect(mockIndexPages).not.toHaveBeenCalled();
  });

  it("resolves the collection before touching a page", async () => {
    mockResolve.mockResolvedValue(null);

    const failure = (await read({ page_path: "chapter-01/bare-metal" })) as Failure;

    expect(failure.error).toBe("KB_NOT_AVAILABLE");
    expect(mockGetPage).not.toHaveBeenCalled();
  });

  it("keeps provenance out of the envelope", async () => {
    bound();
    page("body", { sourceRef: "/etc/secret-manuscript.pdf" });

    const ok = (await read({ page_path: "chapter-01/bare-metal" })) as ReadKbPageOk;

    expect(ok).not.toHaveProperty("sourceRef");
    expect(ok).not.toHaveProperty("source_ref");
  });
});
