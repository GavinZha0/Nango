import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let currentRoot = "";

vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) =>
    key === "host.file.root" ? currentRoot : defaultValue,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

vi.mock("@/lib/copilot/index.server", () => ({
  defineTool: <T>(def: T) => def,
}));

import {
  buildDeleteFileTool,
  buildMoveFileTool,
} from "@/lib/host-files/runtime-tools";
import type {
  DeleteFileEnvelope,
  MoveFileEnvelope,
} from "@/lib/host-files/schema";

describe("host-files management tools (move_file & delete_file)", () => {
  let tmpRoot = "";

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "nango-manage-"));
    currentRoot = tmpRoot;
    await mkdir(path.join(tmpRoot, "dirA"), { recursive: true });
    await mkdir(path.join(tmpRoot, "dirB"), { recursive: true });
    await writeFile(path.join(tmpRoot, "dirA", "note.txt"), "hello", "utf8");
    await writeFile(path.join(tmpRoot, "dirB", "existing.txt"), "old", "utf8");
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("move_file renames and moves a file, and refuses overwrite by default", async () => {
    const move = buildMoveFileTool();

    const blocked = (await move.execute!({
      source_path: "dirA/note.txt",
      destination_path: "dirB/existing.txt",
    })) as MoveFileEnvelope;
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toBe("EXISTS");
    }

    const ok = (await move.execute!({
      source_path: "dirA/note.txt",
      destination_path: "dirB/existing.txt",
      overwrite: true,
    })) as MoveFileEnvelope;
    expect(ok).toEqual({
      ok: true,
      sourcePath: "dirA/note.txt",
      destinationPath: "dirB/existing.txt",
      kind: "file",
    });

    const content = await readFile(path.join(tmpRoot, "dirB", "existing.txt"), "utf8");
    expect(content).toBe("hello");
    await expect(access(path.join(tmpRoot, "dirA", "note.txt"))).rejects.toThrow();
  });

  it("move_file rejects moving root or moving a directory into itself", async () => {
    const move = buildMoveFileTool();

    const rootRes = (await move.execute!({
      source_path: ".",
      destination_path: "dirB/root",
    })) as MoveFileEnvelope;
    expect(rootRes.ok).toBe(false);
    if (!rootRes.ok) expect(rootRes.error).toBe("INVALID_PATH");

    const selfChild = (await move.execute!({
      source_path: "dirA",
      destination_path: "dirA/nested",
    })) as MoveFileEnvelope;
    expect(selfChild.ok).toBe(false);
    if (!selfChild.ok) expect(selfChild.error).toBe("INVALID_PATH");
  });

  it("delete_file deletes files and empty directories, but refuses non-empty directories and root", async () => {
    const del = buildDeleteFileTool();

    const rootRes = (await del.execute!({ path: "." })) as DeleteFileEnvelope;
    expect(rootRes.ok).toBe(false);
    if (!rootRes.ok) expect(rootRes.error).toBe("INVALID_PATH");

    const nonEmpty = (await del.execute!({ path: "dirA" })) as DeleteFileEnvelope;
    expect(nonEmpty.ok).toBe(false);
    if (!nonEmpty.ok) expect(nonEmpty.error).toBe("WRITE_FAILED");

    const delFile = (await del.execute!({ path: "dirA/note.txt" })) as DeleteFileEnvelope;
    expect(delFile).toEqual({ ok: true, path: "dirA/note.txt", kind: "file" });

    const delEmptyDir = (await del.execute!({ path: "dirA" })) as DeleteFileEnvelope;
    expect(delEmptyDir).toEqual({ ok: true, path: "dirA", kind: "directory" });
  });
});
