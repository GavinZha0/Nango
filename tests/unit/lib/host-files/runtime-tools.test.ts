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
  buildReadFileTool,
  buildWriteFileTool,
} from "@/lib/host-files/runtime-tools";
import type {
  CreateFolderEnvelope,
  ReadFileEnvelope,
  WriteFileEnvelope,
} from "@/lib/host-files/schema";

let sandbox: string;
let root: string;

async function read(args: {
  path: string;
  offset?: number;
  limit?: number;
}): Promise<ReadFileEnvelope> {
  const tool = buildReadFileTool();
  return (await tool.execute!(args)) as ReadFileEnvelope;
}

async function write(args: { path: string; content: string }): Promise<WriteFileEnvelope> {
  const tool = buildWriteFileTool();
  return (await tool.execute!(args)) as WriteFileEnvelope;
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
