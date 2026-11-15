import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let currentRoot = "";
const mockReadMaxBytes = 1_048_576;

vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) =>
    key === "host.file.root" ? currentRoot : defaultValue,
  getConfigNumber: (key: string, defaultValue: number) =>
    key === "host.file.read_max_bytes" ? mockReadMaxBytes : defaultValue,
}));

vi.mock("@/lib/copilot/index.server", () => ({
  defineTool: <T>(def: T) => def,
}));

import {
  buildFindFilesTool,
  buildGrepFilesTool,
} from "@/lib/host-files/runtime-tools";
import type {
  FindFilesEnvelope,
  GrepFilesEnvelope,
} from "@/lib/host-files/schema";

describe("host-files search tools (find_files & grep_files)", () => {
  let tmpRoot = "";
  let outsideDir = "";

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "nango-search-"));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), "nango-outside-"));
    currentRoot = tmpRoot;

    await mkdir(path.join(tmpRoot, "src", "utils"), { recursive: true });
    await mkdir(path.join(tmpRoot, "docs"), { recursive: true });
    await mkdir(path.join(tmpRoot, "node_modules", "pkg"), { recursive: true });

    await writeFile(path.join(tmpRoot, "README.md"), "# Hello World\nWelcome to Nango\n", "utf8");
    await writeFile(
      path.join(tmpRoot, "src", "index.ts"),
      'export const greeting = "Hello Nango";\nexport const version = 1;\n',
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "src", "utils", "math.ts"),
      "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "docs", "guide.md"),
      "Guide line 1\nSearch target: NANGO_TOKEN\n",
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "node_modules", "pkg", "index.ts"),
      "// should be ignored by walk\nexport const hello = true;\n",
      "utf8",
    );
    // Binary file with null bytes should be skipped by grep_files
    await writeFile(
      path.join(tmpRoot, "src", "binary.bin"),
      Buffer.from([0x00, 0x01, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00]),
    );
    await writeFile(
      path.join(outsideDir, "secret.txt"),
      "OUTSIDE_SECRET_LINE\n",
      "utf8",
    );

    // Attempt symlink creation (may be skipped on Windows without privilege)
    try {
      await symlink(
        path.join(outsideDir, "secret.txt"),
        path.join(tmpRoot, "leak.txt"),
      );
    } catch {
      // Ignore on restricted Windows environments
    }
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("find_files matches recursive glob patterns and skips node_modules and symlinks", async () => {
    const tool = buildFindFilesTool();
    const res = (await tool.execute!({ pattern: "**/*.ts" })) as FindFilesEnvelope;
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.files.map((f) => f.path)).toEqual([
      "src/index.ts",
      "src/utils/math.ts",
    ]);
    expect(res.truncated).toBe(false);
  });

  it("find_files respects subpath and limit", async () => {
    const tool = buildFindFilesTool();
    const res = (await tool.execute!({
      pattern: "**/*",
      path: "src",
      limit: 1,
    })) as FindFilesEnvelope;
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.root).toBe("src");
    expect(res.files).toHaveLength(1);
    expect(res.truncated).toBe(true);
  });

  it("find_files returns ROOT_NOT_CONFIGURED when root is empty", async () => {
    currentRoot = "";
    const tool = buildFindFilesTool();
    const res = (await tool.execute!({ pattern: "**/*.ts" })) as FindFilesEnvelope;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("ROOT_NOT_CONFIGURED");
  });

  it("grep_files searches text files, skips binary and symlinks, and reports line numbers", async () => {
    const tool = buildGrepFilesTool();
    const res = (await tool.execute!({
      query: "hello",
      case_sensitive: false,
    })) as GrepFilesEnvelope;
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.matches).toEqual([
      { path: "README.md", line: 1, text: "# Hello World" },
      { path: "src/index.ts", line: 1, text: 'export const greeting = "Hello Nango";' },
    ]);
  });

  it("grep_files supports regex, glob filter, and single-file target", async () => {
    const tool = buildGrepFilesTool();
    const res = (await tool.execute!({
      query: "NANGO_[A-Z]+",
      is_regex: true,
      glob: "**/*.md",
    })) as GrepFilesEnvelope;
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.matches).toEqual([
      { path: "docs/guide.md", line: 2, text: "Search target: NANGO_TOKEN" },
    ]);

    const single = (await tool.execute!({
      query: "return a + b",
      path: "src/utils/math.ts",
    })) as GrepFilesEnvelope;
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.matches).toEqual([
      { path: "src/utils/math.ts", line: 2, text: "  return a + b;" },
    ]);
  });

  it("grep_files returns INVALID_PATTERN for invalid regex", async () => {
    const tool = buildGrepFilesTool();
    const res = (await tool.execute!({
      query: "[unclosed",
      is_regex: true,
    })) as GrepFilesEnvelope;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_PATTERN");
  });
});
