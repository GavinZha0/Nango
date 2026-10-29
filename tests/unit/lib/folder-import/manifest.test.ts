import { describe, expect, it } from "vitest";

import {
  folderManifestSchema,
  isUnsafeImportPath,
  noiseReason,
  validateTextBytes,
} from "@/lib/folder-import/manifest";

describe("isUnsafeImportPath", () => {
  it.each([
    "../escape.md",
    "references/../escape.md",
    "..\\windows.md",
    "references\\back.md",
    "/absolute/path.md",
  ])("flags %s", (path) => {
    expect(isUnsafeImportPath(path)).toBe(true);
  });

  it.each([
    "references/guide.md",
    "scripts/run.py",
    "LICENSE",
    // Dots inside a segment are ordinary characters.
    "assets/v1.2/logo.png",
    "notes.md~",
  ])("accepts %s", (path) => {
    expect(isUnsafeImportPath(path)).toBe(false);
  });
});

describe("validateTextBytes", () => {
  it("rejects NUL bytes in text", () => {
    expect(validateTextBytes(Buffer.from("hello"))).toBeNull();
    expect(validateTextBytes(Buffer.from([0x68, 0x00, 0x69]))).toMatch(
      /NUL bytes/,
    );
  });
});

describe("noiseReason", () => {
  it.each([
    ".env",
    ".github/workflows/ci.yml",
    "references/.env.local",
    "__MACOSX/foo",
    "node_modules/pkg/index.js",
    "__pycache__/probe.cpython-311.pyc",
    "scripts/node_modules/pkg/index.js",
    "venv/lib/python3.11/site-packages/native.so",
    "lib/pkg.egg-info/PKG-INFO",
    "lib/pkg.dist-info/METADATA",
    "Thumbs.db",
    "desktop.ini",
    "notes.md~",
  ])("treats %s as folder noise", (path) => {
    expect(noiseReason(path)).toBe("noise or dotfile");
  });

  it.each([
    "build/probe.pyc",
    "debug.log",
    "app.js.map",
    "tsconfig.tsbuildinfo",
    "yarn.lock",
  ])("treats %s as a generated artifact", (path) => {
    expect(noiseReason(path)).toBe("generated build or tool artifact");
  });

  it.each(["references/guide.md", "LICENSE", "scripts/run.py"])(
    "keeps authoring source %s",
    (path) => {
      expect(noiseReason(path)).toBeNull();
    },
  );
});

describe("folderManifestSchema", () => {
  const entry = { path: "a.md", contentBase64: "aGk=" };

  it("accepts a manifest of entries", () => {
    expect(folderManifestSchema.safeParse({ entries: [entry] }).success).toBe(
      true,
    );
  });

  it("requires at least one entry", () => {
    expect(folderManifestSchema.safeParse({ entries: [] }).success).toBe(false);
  });

  it("caps the entry count", () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({
      ...entry,
      path: `f${i}.md`,
    }));
    expect(folderManifestSchema.safeParse({ entries }).success).toBe(false);
  });

  it("rejects an empty or oversized path and empty content", () => {
    expect(
      folderManifestSchema.safeParse({
        entries: [{ ...entry, path: "" }],
      }).success,
    ).toBe(false);
    expect(
      folderManifestSchema.safeParse({
        entries: [{ ...entry, path: "x".repeat(300) }],
      }).success,
    ).toBe(false);
    expect(
      folderManifestSchema.safeParse({
        entries: [{ ...entry, contentBase64: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      folderManifestSchema.safeParse({ entries: [entry], root: "folder" })
        .success,
    ).toBe(false);
  });
});
