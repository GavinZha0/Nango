import { describe, expect, it } from "vitest";

import {
  bytesToBase64,
  collectFolderFiles,
  toManifestPath,
  type CollectPolicy,
} from "@/lib/folder-import/collect";
import type { FilePolicyResult } from "@/lib/folder-import/manifest";

const POLICY: CollectPolicy = {
  admit: (path): FilePolicyResult =>
    path.startsWith(".")
      ? { action: "ignore", reason: "noise or dotfile" }
      : path.endsWith(".exe")
        ? { action: "block", reason: "executable file" }
        : { action: "allow-text" },
  maxFiles: 3,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
};

/** `webkitRelativePath` is read-only, so the picker output is shaped by hand. */
function pick(relativePath: string, text: string): File {
  return {
    name: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    webkitRelativePath: relativePath,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  } as unknown as File;
}

function bigText(bytes: number): string {
  return "x".repeat(bytes);
}

describe("toManifestPath", () => {
  it("drops the picked root folder", () => {
    expect(toManifestPath("my-skill/references/guide.md", "guide.md")).toBe(
      "references/guide.md",
    );
    expect(toManifestPath("my-skill/SKILL.md", "SKILL.md")).toBe("SKILL.md");
  });

  it("falls back to the file name when the picker gave no relative path", () => {
    expect(toManifestPath("", "notes.md")).toBe("notes.md");
  });
});

describe("bytesToBase64", () => {
  it("round-trips multibyte text", () => {
    const bytes = new TextEncoder().encode("知识库 — utf-8");
    expect(Buffer.from(bytesToBase64(bytes), "base64").toString("utf-8")).toBe(
      "知识库 — utf-8",
    );
  });

  it("round-trips past the chunk size limit", () => {
    // QUIRK: `String.fromCharCode(...)` overflows its argument list on a large
    // buffer, which is why this encodes in 32 KB chunks.
    const bytes = new Uint8Array(70_000).fill(0x41);
    expect(Buffer.from(bytesToBase64(bytes), "base64")).toEqual(Buffer.from(bytes));
  });
});

describe("collectFolderFiles", () => {
  it("builds entries from the picked tree and reports skipped noise", async () => {
    const out = await collectFolderFiles(
      [pick("kb/readme.md", "hello"), pick("kb/.DS_Store", "junk")],
      POLICY,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries).toEqual([
      { path: "readme.md", contentBase64: Buffer.from("hello").toString("base64") },
    ]);
    expect(out.skipped).toEqual([".DS_Store"]);
  });

  it("fails on a blocked file naming it with the reason", async () => {
    expect(await collectFolderFiles([pick("kb/setup.exe", "bin")], POLICY)).toEqual({
      ok: false,
      message: '"setup.exe" (executable file)',
    });
  });

  it("fails on the file-count cap", async () => {
    const four = [
      pick("kb/a.md", "1"),
      pick("kb/b.md", "2"),
      pick("kb/c.md", "3"),
      pick("kb/d.md", "4"),
    ];
    expect(await collectFolderFiles(four, POLICY)).toEqual({
      ok: false,
      message: "The folder exceeds the 3 file limit.",
    });
  });

  it("fails on the per-file cap naming the path", async () => {
    const out = await collectFolderFiles([pick("kb/big.md", bigText(300 * 1024))], POLICY);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toBe('"big.md" exceeds the 256 KB per-file limit.');
    }
  });

  it("fails on the total budget", async () => {
    const three = [
      pick("kb/a.md", bigText(400 * 1024)),
      pick("kb/b.md", bigText(400 * 1024)),
      pick("kb/c.md", bigText(400 * 1024)),
    ];
    const out = await collectFolderFiles(three, {
      ...POLICY,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 1024 * 1024,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toBe("The folder exceeds the 1 MB total limit.");
    }
  });
});
