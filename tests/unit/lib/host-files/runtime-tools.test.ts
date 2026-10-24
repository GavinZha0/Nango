import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  buildCreateFolderTool,
  buildEditFileTool,
  buildReadFileTool,
  buildWriteFileTool,
} from "@/lib/host-files/runtime-tools";
import type {
  CreateFolderEnvelope,
  EditFileEnvelope,
  ReadFileEnvelope,
  WriteFileEnvelope,
} from "@/lib/host-files/schema";

let sandbox: string;
let root: string;

async function read(args: {
  path: string;
  offset?: number;
  limit?: number;
  raw?: boolean;
}): Promise<ReadFileEnvelope> {
  const tool = buildReadFileTool();
  return (await tool.execute!(args)) as ReadFileEnvelope;
}

async function write(args: {
  path: string;
  content: string;
  mode?: "overwrite" | "append";
}): Promise<WriteFileEnvelope> {
  const tool = buildWriteFileTool();
  return (await tool.execute!(args)) as WriteFileEnvelope;
}

async function edit(args: {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}): Promise<EditFileEnvelope> {
  const tool = buildEditFileTool();
  return (await tool.execute!(args)) as EditFileEnvelope;
}

async function createFolder(args: { path: string }): Promise<CreateFolderEnvelope> {
  const tool = buildCreateFolderTool();
  return (await tool.execute!(args)) as CreateFolderEnvelope;
}

beforeEach(async () => {
  const created = await mkdtemp(path.join(tmpdir(), "nango-hostfiles-"));
  sandbox = await realpath(created);
  root = path.join(sandbox, "root");
  await mkdir(root, { recursive: true });
  Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  mockConfig["host.file.root"] = root;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(sandbox, { recursive: true, force: true });
});

describe("unconfigured root", () => {
  it("refuses both tools when host.file.root is empty", async () => {
    mockConfig["host.file.root"] = "";
    const r = await read({ path: "a.md" });
    const w = await write({ path: "a.md", content: "x" });
    expect(!r.ok && r.error === "ROOT_NOT_CONFIGURED").toBe(true);
    expect(!w.ok && w.error === "ROOT_NOT_CONFIGURED").toBe(true);
    // CONTRACT: with no availability gate, the message is the only place
    // the agent learns what to ask the operator for.
    if (!r.ok) expect(r.message).toMatch(/host\.file\.root/);
    if (!r.ok) expect(r.message).toMatch(/mount/i);
    if (!w.ok) expect(w.message).toMatch(/host\.file\.root/);
  });
});

describe("read_file", () => {
  it("returns whole-file content with line bounds", async () => {
    await writeFile(path.join(root, "notes.md"), "one\ntwo\nthree");

    const res = await read({ path: "notes.md" });
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      expect(res.content).toBe("one\ntwo\nthree");
      expect(res.path).toBe("notes.md");
      expect(res.startLine).toBe(1);
      expect(res.endLine).toBe(3);
      expect(res.truncated).toBe(false);
    }
  });

  it("normalizes CRLF so line windows are stable", async () => {
    await writeFile(path.join(root, "crlf.txt"), "a\r\nb\r\nc");
    const res = await read({ path: "crlf.txt" });
    expect(res.ok && res.kind === "file" && res.content).toBe("a\nb\nc");
  });

  it("windows by offset/limit and reports truncation", async () => {
    await writeFile(path.join(root, "many.txt"), Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n"));

    const first = await read({ path: "many.txt", offset: 1, limit: 4 });
    expect(first.ok && first.kind === "file" && first.content).toBe("l1\nl2\nl3\nl4");
    if (first.ok && first.kind === "file") {
      expect(first.truncated).toBe(true);
      expect(first.endLine).toBe(4);
    }

    const second = await read({ path: "many.txt", offset: 5, limit: 10 });
    expect(second.ok && second.kind === "file" && second.content).toBe(
      "l5\nl6\nl7\nl8\nl9\nl10",
    );
    if (second.ok && second.kind === "file") {
      expect(second.truncated).toBe(false);
      expect(second.endLine).toBe(10);
    }
  });

  it("treats an offset past EOF as an empty window, not an error", async () => {
    await writeFile(path.join(root, "short.txt"), "only\n");
    const res = await read({ path: "short.txt", offset: 99 });
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      expect(res.content).toBe("");
      expect(res.truncated).toBe(false);
    }
  });

  it("streams files above the byte budget instead of buffering them", async () => {
    mockConfig["host.file.read_max_bytes"] = "40";
    const lines = Array.from({ length: 10 }, (_, i) => `line0${i}`);
    await writeFile(path.join(root, "big.txt"), lines.join("\n"));

    const res = await read({ path: "big.txt", limit: 2 });
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      expect(res.content).toBe("line00\nline01");
      expect(res.truncated).toBe(true);
      expect(res.sizeBytes).toBeGreaterThan(40);
    }
  });

  it("rejects non-UTF-8 content as NOT_TEXT", async () => {
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x9c]));
    const res = await read({ path: "bin.dat" });
    expect(!res.ok && res.error === "NOT_TEXT").toBe(true);
  });

  it("lists a directory with directories first and sizes for files", async () => {
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "b.txt"), "bb");
    await writeFile(path.join(root, "a.txt"), "aaa");

    const res = await read({ path: "." });
    expect(res.ok && res.kind === "directory").toBe(true);
    if (res.ok && res.kind === "directory") {
      expect(res.path).toBe(".");
      expect(res.entries.map((e) => e.name)).toEqual(["sub", "a.txt", "b.txt"]);
      expect(res.entries[0].kind).toBe("directory");
      expect(res.entries[1].sizeBytes).toBe(3);
      expect(res.truncated).toBe(false);
    }
  });

  it("reports NOT_FOUND for a missing path", async () => {
    const res = await read({ path: "ghost.md" });
    expect(!res.ok && res.error === "NOT_FOUND").toBe(true);
  });

  it("refuses to leave the jail", async () => {
    await writeFile(path.join(sandbox, "outside.txt"), "secret");
    const res = await read({ path: "../outside.txt" });
    expect(!res.ok).toBe(true);
    if (!res.ok) expect(["PATH_ESCAPE", "NOT_FOUND"]).toContain(res.error);
  });
});

describe("write_file", () => {
  it("creates a new file and reports created=true", async () => {
    const res = await write({ path: "report.md", content: "# Hi\n" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.created).toBe(true);
      expect(res.path).toBe("report.md");
      expect(res.sizeBytes).toBe(5);
    }
    const back = await read({ path: "report.md" });
    expect(back.ok && back.kind === "file" && back.content).toBe("# Hi\n");
  });

  it("replaces an existing file wholesale and reports created=false", async () => {
    await writeFile(path.join(root, "log.txt"), "old content that is long");
    const res = await write({ path: "log.txt", content: "new" });
    expect(res.ok && res.created).toBe(false);
    const back = await read({ path: "log.txt" });
    expect(back.ok && back.kind === "file" && back.content).toBe("new");
  });

  it("leaves no temp file behind after a replace", async () => {
    await writeFile(path.join(root, "log.txt"), "old");
    await write({ path: "log.txt", content: "new" });
    const listing = await read({ path: "." });
    expect(listing.ok && listing.kind === "directory").toBe(true);
    if (listing.ok && listing.kind === "directory") {
      expect(listing.entries.map((e) => e.name)).toEqual(["log.txt"]);
    }
  });

  it("honours the write byte budget", async () => {
    mockConfig["host.file.write_max_bytes"] = "10";
    const res = await write({ path: "big.md", content: "x".repeat(50) });
    expect(!res.ok && res.error === "TOO_LARGE").toBe(true);
  });

  it("requires an existing parent directory", async () => {
    const res = await write({ path: "missing-dir/file.md", content: "x" });
    expect(!res.ok && res.error === "NOT_FOUND").toBe(true);
    if (!res.ok) expect(res.message).toMatch(/parent directory/);
  });

  it("refuses to overwrite a directory", async () => {
    await mkdir(path.join(root, "folder"), { recursive: true });
    const res = await write({ path: "folder", content: "x" });
    expect(!res.ok && res.error === "IS_DIRECTORY").toBe(true);
  });

  it("normalizes a leading slash into the jail", async () => {
    const res = await write({ path: "/root-note.md", content: "inside" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("root-note.md");
  });

  it("refuses to write outside the jail", async () => {
    const res = await write({ path: "../escaped.md", content: "x" });
    expect(!res.ok).toBe(true);
    if (!res.ok) expect(["PATH_ESCAPE", "NOT_FOUND"]).toContain(res.error);
  });
});

describe("create_folder", () => {
  it("creates missing parents in one call", async () => {
    const res = await createFolder({ path: "inbox/debian/current" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.created).toBe(true);
      expect(res.path).toBe("inbox/debian/current");
    }
    const st = await stat(path.join(root, "inbox", "debian", "current"));
    expect(st.isDirectory()).toBe(true);
  });

  it("is a safe no-op for a directory that already exists", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });

    const res = await createFolder({ path: "notes" });
    // CONTRACT: created:false is success — an agent re-issuing mkdir to
    // "make sure" must not read it as a failure and retry.
    expect(res.ok && res.created).toBe(false);
    if (res.ok) expect(res.path).toBe("notes");
  });

  it("reports the root itself as an existing directory", async () => {
    for (const input of ["/", "."]) {
      const res = await createFolder({ path: input });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.created).toBe(false);
        expect(res.path).toBe(".");
      }
    }
  });

  it("refuses to mint a directory over an existing file", async () => {
    await writeFile(path.join(root, "notes"), "i am a file");

    const res = await createFolder({ path: "notes" });
    expect(!res.ok && res.error === "IS_FILE").toBe(true);
    if (!res.ok) expect(res.message).toMatch(/no delete or rename/i);
  });

  it("unblocks write_file for a path that previously could not be written", async () => {
    // This composition is the whole reason the tool exists.
    const before = await write({ path: "reports/2026/digest.md", content: "x" });
    expect(!before.ok && before.error === "NOT_FOUND").toBe(true);

    expect((await createFolder({ path: "reports/2026" })).ok).toBe(true);
    const after = await write({ path: "reports/2026/digest.md", content: "shipped" });
    expect(after.ok).toBe(true);
    const back = await read({ path: "reports/2026/digest.md" });
    expect(back.ok && back.kind === "file" && back.content).toBe("shipped");
  });

  it("neutralizes an absolute path into the mount", async () => {
    const res = await createFolder({ path: "/inbox/downloads" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("inbox/downloads");
  });

  it("refuses to create outside the jail", async () => {
    const res = await createFolder({ path: "../../escaped" });
    expect(!res.ok && res.error === "PATH_ESCAPE").toBe(true);
    await expect(stat(path.join(sandbox, "..", "escaped"))).rejects.toBeTruthy();
  });

  it("rejects blank and NUL input", async () => {
    const blank = await createFolder({ path: "   " });
    expect(!blank.ok && blank.error === "INVALID_PATH").toBe(true);

    const nul = await createFolder({ path: "a\0b" });
    expect(!nul.ok && nul.error === "INVALID_PATH").toBe(true);
  });

  it("refuses when no root is mounted", async () => {
    mockConfig["host.file.root"] = "";
    const res = await createFolder({ path: "inbox" });
    expect(!res.ok && res.error === "ROOT_NOT_CONFIGURED").toBe(true);
  });
});

describe("write_file mode: append", () => {
  it("adds content to the end and reports the grown size", async () => {
    await write({ path: "log.txt", content: "line one\n" });

    const res = await write({ path: "log.txt", content: "line two\n", mode: "append" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.created).toBe(false);
      expect(res.sizeBytes).toBe(Buffer.byteLength("line one\nline two\n"));
    }
    const back = await read({ path: "log.txt" });
    if (back.ok && back.kind === "file") expect(back.content).toBe("line one\nline two\n");
  });

  it("creates the file when it does not exist yet", async () => {
    const res = await write({ path: "fresh.md", content: "start\n", mode: "append" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.created).toBe(true);
  });

  it("budgets the appended chunk, not the resulting file", async () => {
    // CONTRACT: append is what makes a file larger than the write budget
    // still writable — the cap is per call, so a grown file must not block
    // the next small append.
    mockConfig["host.file.write_max_bytes"] = "64";
    await write({ path: "big.txt", content: "x".repeat(64) });

    const res = await write({ path: "big.txt", content: "more\n", mode: "append" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sizeBytes).toBe(69);
  });

  it("refuses a chunk over the budget without touching the file", async () => {
    mockConfig["host.file.write_max_bytes"] = "16";
    await write({ path: "keep.txt", content: "original" });

    const res = await write({ path: "keep.txt", content: "y".repeat(40), mode: "append" });
    expect(!res.ok && res.error === "TOO_LARGE").toBe(true);
    const back = await read({ path: "keep.txt" });
    if (back.ok && back.kind === "file") expect(back.content).toBe("original");
  });

  it("keeps the missing-parent refusal pointing at create_folder", async () => {
    const res = await write({ path: "nope/deeper/a.txt", content: "x", mode: "append" });
    expect(!res.ok && res.error === "NOT_FOUND").toBe(true);
    if (!res.ok) expect(res.message).toMatch(/create_folder/);
  });

  it("refuses to append onto a directory", async () => {
    await mkdir(path.join(root, "folder"), { recursive: true });
    const res = await write({ path: "folder", content: "x", mode: "append" });
    expect(!res.ok && res.error === "IS_DIRECTORY").toBe(true);
  });

  it("floors a mis-set write budget instead of accepting anything", async () => {
    mockConfig["host.file.write_max_bytes"] = "-1";

    // CONTRACT: the budget floors at 1 byte, so a negative config blocks
    // every real payload rather than disabling the guard.
    const refused = await write({ path: "floor.txt", content: "ab" });
    expect(!refused.ok && refused.error === "TOO_LARGE").toBe(true);
  });

  it("is jailed like overwrite", async () => {
    const res = await write({ path: "../outside.txt", content: "x", mode: "append" });
    expect(!res.ok && res.error === "PATH_ESCAPE").toBe(true);
  });
});

describe("read_file raw", () => {
  it("returns the file byte-for-byte with no line windowing", async () => {
    await writeFile(path.join(root, "crlf.txt"), "one\r\ntwo\r\nthree");

    const res = await read({ path: "crlf.txt", raw: true });
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      // CONTRACT: raw keeps CRLF; the windowed path normalizes it to LF.
      expect(res.content).toBe("one\r\ntwo\r\nthree");
      expect(res.truncated).toBe(false);
      expect(res.startLine).toBeUndefined();
      expect(res.endLine).toBeUndefined();
    }
  });

  it("ignores limit and reads from the byte offset", async () => {
    await writeFile(path.join(root, "lines.txt"), "a\nb\nc\nd\ne");

    // CONTRACT: in a raw read `offset` is a byte position, not a line, and
    // `limit` plays no part — the byte budget is the only bound.
    const res = await read({ path: "lines.txt", raw: true, offset: 3, limit: 1 });
    if (res.ok && res.kind === "file") {
      expect(res.content).toBe("b\nc\nd\ne");
      expect(res.truncated).toBe(false);
      expect(res.nextByteOffset).toBeUndefined();
    }
  });

  it("caps at the byte budget and marks the cut", async () => {
    mockConfig["host.file.read_max_bytes"] = "16";
    await writeFile(path.join(root, "long.txt"), "z".repeat(400));

    const res = await read({ path: "long.txt", raw: true });
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      expect(res.content).toHaveLength(16);
      expect(res.truncated).toBe(true);
      expect(res.nextByteOffset).toBe(17);
      // sizeBytes is the real file, not the returned slice.
      expect(res.sizeBytes).toBe(400);
    }
  });

  it("reassembles the whole file through nextByteOffset", async () => {
    mockConfig["host.file.read_max_bytes"] = "16";
    const body = `${"x".repeat(100)} middle \u4e2d\u4e2d tail`;
    await writeFile(path.join(root, "long.txt"), body, "utf8");

    let content = "";
    let offset = 1;
    for (let page = 0; page < 20; page++) {
      const res = await read({ path: "long.txt", raw: true, offset });
      if (!(res.ok && res.kind === "file")) throw new Error("raw read failed");
      content += res.content;
      if (!res.truncated) break;
      offset = res.nextByteOffset!;
    }
    // CONTRACT: byte paging is lossless — no dropped or duplicated byte, and
    // no character split across windows.
    expect(content).toBe(body);
  });

  it("does not cut a multi-byte character in half", async () => {
    mockConfig["host.file.read_max_bytes"] = "4";
    // "ok" plus two 3-byte characters: byte 4 lands inside the first one,
    // so the naive slice would decode to a replacement character.
    await writeFile(path.join(root, "utf.txt"), "ok\u4e2d\u4e2d", "utf8");

    const res = await read({ path: "utf.txt", raw: true });
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      expect(res.content).toBe("ok");
      expect(res.content).not.toContain("\uFFFD");
      expect(res.truncated).toBe(true);
      expect(res.sizeBytes).toBe(8);
      // The dropped partial belongs to the next window, so continuing from
      // here re-reads nothing and loses nothing.
      expect(res.nextByteOffset).toBe(3);

      const rest = await read({ path: "utf.txt", raw: true, offset: res.nextByteOffset });
      // Budget is still 4 bytes, so this window holds one whole character
      // and the cut again lands inside the next one.
      if (rest.ok && rest.kind === "file") {
        expect(rest.content).toBe("\u4e2d");
        expect(rest.nextByteOffset).toBe(6);
      }
    }
  });

  it("floors a mis-set read budget so a page still advances", async () => {
    mockConfig["host.file.read_max_bytes"] = "0";
    await writeFile(path.join(root, "floor.txt"), "abc");

    const res = await read({ path: "floor.txt", raw: true });
    // CONTRACT: a zero budget is a mis-configuration, not a mode — an empty
    // page that claims there is more to come has no escape.
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      expect(res.content).toBe("a");
      expect(res.truncated).toBe(true);
      expect(res.nextByteOffset).toBe(2);
    }
  });

  it("still refuses a binary file", async () => {
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const res = await read({ path: "bin.dat", raw: true });
    expect(!res.ok && res.error === "NOT_TEXT").toBe(true);
  });
});

describe("read_file streaming window bounds", () => {
  it("cuts a single oversized line instead of returning it whole", async () => {
    // Regression: the byte budget was tested before pushing a line, so one
    // line longer than the budget sailed through into the context.
    mockConfig["host.file.read_max_bytes"] = "64";
    await writeFile(path.join(root, "one-line.json"), `${"x".repeat(5000)}\nsecond`);

    const res = await read({ path: "one-line.json" });
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      expect(res.content.length).toBeLessThanOrEqual(64);
      expect(res.truncated).toBe(true);
    }
  });

  it("keeps windowed reads for normal files", async () => {
    mockConfig["host.file.read_max_bytes"] = "32";
    const body = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
    await writeFile(path.join(root, "many.txt"), body);

    const res = await read({ path: "many.txt", offset: 1, limit: 5 });
    if (res.ok && res.kind === "file") {
      expect(res.content).toBe("l0\nl1\nl2\nl3\nl4");
      expect(res.endLine).toBe(5);
      expect(res.truncated).toBe(true);
    }
  });

  it("leaves the tail of a cut line reachable through a raw read", async () => {
    // Regression: a line window cannot resume inside the line it cut, so the
    // bytes past the budget had no path back into the conversation.
    mockConfig["host.file.read_max_bytes"] = "64";
    await writeFile(path.join(root, "one-line.json"), `${"x".repeat(5000)} NEEDLE`);

    const nextLine = await read({ path: "one-line.json", offset: 2 });
    if (nextLine.ok && nextLine.kind === "file") {
      expect(nextLine.content).toBe("");
      expect(nextLine.truncated).toBe(false);
    }

    const tail = await read({ path: "one-line.json", raw: true, offset: 4998 });
    expect(tail.ok && tail.kind === "file").toBe(true);
    if (tail.ok && tail.kind === "file") {
      expect(tail.content).toBe("xxx NEEDLE");
      expect(tail.truncated).toBe(false);
    }
  });

  it("returns an empty raw window past EOF", async () => {
    await writeFile(path.join(root, "short.txt"), "four");
    const res = await read({ path: "short.txt", raw: true, offset: 99 });
    expect(res.ok && res.kind === "file").toBe(true);
    if (res.ok && res.kind === "file") {
      expect(res.content).toBe("");
      expect(res.truncated).toBe(false);
      expect(res.nextByteOffset).toBeUndefined();
    }
  });
});

describe("read_file directory pagination", () => {
  async function seedEntries(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const name = `f${String(i).padStart(3, "0")}.txt`;
      await writeFile(path.join(root, name), "x");
    }
  }

  it("pages with offset and reports exact bounds", async () => {
    await seedEntries(5);

    const first = await read({ path: "/", limit: 2 });
    expect(first.ok && first.kind === "directory").toBe(true);
    if (first.ok && first.kind === "directory") {
      expect(first.entries.map((e) => e.name)).toEqual(["f000.txt", "f001.txt"]);
      expect(first.startEntry).toBe(1);
      expect(first.endEntry).toBe(2);
      expect(first.truncated).toBe(true);
    }

    const last = await read({ path: "/", offset: 5, limit: 2 });
    if (last.ok && last.kind === "directory") {
      expect(last.entries.map((e) => e.name)).toEqual(["f004.txt"]);
      expect(last.truncated).toBe(false);
    }
  });

  it("reaches entries past the old 500 hard cap", async () => {
    await seedEntries(501);

    const page = await read({ path: "/", offset: 501 });
    if (page.ok && page.kind === "directory") {
      expect(page.entries.map((e) => e.name)).toEqual(["f500.txt"]);
      expect(page.truncated).toBe(false);
    }
  });

  it("returns an empty page beyond the end rather than an error", async () => {
    await seedEntries(2);
    const res = await read({ path: "/", offset: 9 });
    if (res.ok && res.kind === "directory") {
      expect(res.entries).toEqual([]);
      expect(res.truncated).toBe(false);
    }
  });
});

describe("edit_file", () => {
  it("replaces one unique match and leaves the rest untouched", async () => {
    await write({ path: "notes.md", content: "# Title\nkeep me\nold line\n" });

    const res = await edit({ path: "notes.md", old_string: "old line", new_string: "new line" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.replacements).toBe(1);

    const back = await read({ path: "notes.md" });
    if (back.ok && back.kind === "file") {
      expect(back.content).toBe("# Title\nkeep me\nnew line\n");
    }
  });

  it("refuses a match that appears more than once", async () => {
    await write({ path: "dup.txt", content: "tick\ntick\ntick\n" });

    const res = await edit({ path: "dup.txt", old_string: "tick", new_string: "tock" });
    expect(!res.ok && res.error === "NOT_UNIQUE").toBe(true);
    // CONTRACT: the count is in the message — the agent has no other way to
    // choose between widening the snippet and replace_all.
    if (!res.ok) expect(res.message).toMatch(/3 places/);

    const all = await edit({
      path: "dup.txt",
      old_string: "tick",
      new_string: "tock",
      replace_all: true,
    });
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.replacements).toBe(3);
  });

  it("reports a missing needle without writing", async () => {
    await write({ path: "keep.txt", content: "original" });
    const res = await edit({ path: "keep.txt", old_string: "absent", new_string: "x" });
    expect(!res.ok && res.error === "NOT_IN_FILE").toBe(true);
    const back = await read({ path: "keep.txt" });
    if (back.ok && back.kind === "file") expect(back.content).toBe("original");
  });

  it("deletes text when new_string is empty", async () => {
    await write({ path: "list.txt", content: "a\nb\n c\n" });
    const res = await edit({ path: "list.txt", old_string: "b\n", new_string: "" });
    expect(res.ok).toBe(true);
    const back = await read({ path: "list.txt" });
    if (back.ok && back.kind === "file") expect(back.content).toBe("a\n c\n");
  });

  it("keeps a CRLF file's line endings", async () => {
    await writeFile(path.join(root, "win.txt"), "one\r\ntwo\r\n");

    // The agent pastes what read_file showed it, i.e. LF-normalized.
    const seen = await read({ path: "win.txt" });
    if (seen.ok && seen.kind === "file") expect(seen.content).toBe("one\ntwo\n");

    const res = await edit({ path: "win.txt", old_string: "two", new_string: "three" });
    expect(res.ok).toBe(true);

    const rawBack = await read({ path: "win.txt", raw: true });
    if (rawBack.ok && rawBack.kind === "file") {
      expect(rawBack.content).toBe("one\r\nthree\r\n");
    }
  });

  it("changes only the matched bytes of a mixed-ending file", async () => {
    // Regression: the edit used to normalize the whole file to LF and write
    // CRLF back whenever the file contained one CRLF line, rewriting the
    // endings of lines the edit never touched.
    await writeFile(path.join(root, "mixed.txt"), "a\nb\r\nc\n");

    const res = await edit({ path: "mixed.txt", old_string: "b", new_string: "B" });
    expect(res.ok).toBe(true);

    const rawBack = await read({ path: "mixed.txt", raw: true });
    expect(rawBack.ok && rawBack.kind === "file").toBe(true);
    if (rawBack.ok && rawBack.kind === "file") {
      expect(rawBack.content).toBe("a\nB\r\nc\n");
    }
  });

  it("matches a multi-line snippet copied from a CRLF file", async () => {
    await writeFile(path.join(root, "win2.txt"), "one\r\ntwo\r\nthree\r\n");

    // read_file shows LF, and that is what the agent pastes.
    const seen = await read({ path: "win2.txt" });
    if (!(seen.ok && seen.kind === "file" && seen.content === "one\ntwo\nthree\n")) {
      throw new Error("expected an LF view of the CRLF file");
    }

    const res = await edit({
      path: "win2.txt",
      old_string: "one\ntwo\n",
      new_string: "first\nsecond\n",
    });
    expect(res.ok).toBe(true);

    const rawBack = await read({ path: "win2.txt", raw: true });
    if (rawBack.ok && rawBack.kind === "file") {
      expect(rawBack.content).toBe("first\r\nsecond\r\nthree\r\n");
    }
  });

  it("matches a CRLF snippet against an LF file", async () => {
    await write({ path: "lf.txt", content: "one\ntwo\nthree\n" });

    const res = await edit({
      path: "lf.txt",
      old_string: "one\r\ntwo\r\n",
      new_string: "first\r\nsecond\r\n",
    });
    expect(res.ok).toBe(true);

    const rawBack = await read({ path: "lf.txt", raw: true });
    if (rawBack.ok && rawBack.kind === "file") {
      expect(rawBack.content).toBe("first\nsecond\nthree\n");
    }
  });

  it("refuses a snippet that spans inconsistent endings", async () => {
    await writeFile(path.join(root, "odd.txt"), "one\r\ntwo\nthree\r\n");

    const res = await edit({
      path: "odd.txt",
      old_string: "one\ntwo\nthree",
      new_string: "x",
    });
    expect(!res.ok && res.error === "NOT_IN_FILE").toBe(true);
    if (!res.ok) expect(res.message).toMatch(/raw/);

    const back = await read({ path: "odd.txt", raw: true });
    if (back.ok && back.kind === "file") expect(back.content).toBe("one\r\ntwo\nthree\r\n");
  });

  it("refuses a file over the read budget", async () => {
    mockConfig["host.file.read_max_bytes"] = "32";
    await writeFile(path.join(root, "huge.txt"), `${"a".repeat(40)}needle`);

    const res = await edit({ path: "huge.txt", old_string: "needle", new_string: "x" });
    expect(!res.ok && res.error === "TOO_LARGE").toBe(true);
    // CONTRACT: append cannot replace a substring, so the message must not
    // send the agent there — it names the config key that would fit instead.
    if (!res.ok) {
      expect(res.message).toMatch(/host\.file\.read_max_bytes/);
      expect(res.message).not.toMatch(/append/);
    }
  });

  it("refuses to create a file that does not exist", async () => {
    const res = await edit({ path: "ghost.txt", old_string: "a", new_string: "b" });
    expect(!res.ok && res.error === "NOT_FOUND").toBe(true);
    if (!res.ok) expect(res.message).toMatch(/write_file/);
    await expect(stat(path.join(root, "ghost.txt"))).rejects.toBeTruthy();
  });

  it("stays inside the jail", async () => {
    const res = await edit({ path: "../outside.txt", old_string: "a", new_string: "b" });
    expect(!res.ok && res.error === "PATH_ESCAPE").toBe(true);
  });

  it("refuses a directory target", async () => {
    await mkdir(path.join(root, "folder"), { recursive: true });
    const res = await edit({ path: "folder", old_string: "a", new_string: "b" });
    expect(!res.ok && res.error === "IS_DIRECTORY").toBe(true);
  });

  it("refuses a binary file", async () => {
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0xff, 0xfe, 0x41, 0x42]));
    const res = await edit({ path: "bin.dat", old_string: "A", new_string: "B" });
    expect(!res.ok && res.error === "NOT_TEXT").toBe(true);
  });

  it("leaves no temp file behind when the edit is refused", async () => {
    await write({ path: "clean.txt", content: "hello" });
    const res = await edit({ path: "clean.txt", old_string: "nope", new_string: "x" });
    expect(res.ok).toBe(false);
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(root);
    expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});
