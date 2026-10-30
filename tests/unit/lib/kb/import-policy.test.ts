import { describe, expect, it } from "vitest";

import {
  classifyKbImportPath,
  kbContentType,
  textDecodeProblem,
} from "@/lib/kb/import-policy";

describe("kb/import-policy — text-only admission", () => {
  it("admits prose and data files as text", () => {
    for (const path of [
      "notes.md",
      "a/b/readme.txt",
      "table.csv",
      "config.json",
      "chart.yaml",
      "feed.xml",
      "query.sql",
      "helper.ts",
    ]) {
      expect(classifyKbImportPath(path)).toEqual({ action: "allow-text" });
    }
  });

  it("admits an extension-less file, which the walker proves by NUL scan", () => {
    expect(classifyKbImportPath("LICENSE")).toEqual({ action: "allow-text" });
    expect(classifyKbImportPath("docs/README")).toEqual({ action: "allow-text" });
  });

  it("skips OS and tool noise without failing the import", () => {
    expect(classifyKbImportPath(".DS_Store").action).toBe("ignore");
    expect(classifyKbImportPath("node_modules/x/y.md").action).toBe("ignore");
    expect(classifyKbImportPath("notes/README.bak").action).toBe("ignore");
  });

  it("drops an image with the noise: it could never have been a page", () => {
    for (const path of ["diagram.png", "a/logo.jpg", "icon.ico"]) {
      expect(classifyKbImportPath(path)).toEqual({ action: "ignore" });
    }
  });

  it("refuses a document that could hold prose, with the shared reason", () => {
    expect(classifyKbImportPath("spec.pdf")).toEqual({
      action: "block",
      reason: "PDF document",
    });
    expect(classifyKbImportPath("bundle.zip").reason).toBe("archive file");
    expect(classifyKbImportPath("tool.exe").reason).toBe("executable file");
  });

  it("refuses what no list recognises", () => {
    expect(classifyKbImportPath("mystery.qqq")).toEqual({
      action: "block",
      reason: "unsupported file type",
    });
  });
});

describe("kb/import-policy — content_type hint", () => {
  it("maps the extensions whose MIME guess the CHECK set carries", () => {
    expect(kbContentType("a.md")).toBe("text/markdown");
    expect(kbContentType("a.markdown")).toBe("text/markdown");
    expect(kbContentType("a.txt")).toBe("text/plain");
    expect(kbContentType("a.csv")).toBe("text/csv");
    expect(kbContentType("a.json")).toBe("application/json");
    expect(kbContentType("a.yaml")).toBe("text/yaml");
    expect(kbContentType("a.yml")).toBe("text/yaml");
    expect(kbContentType("a.xml")).toBe("text/xml");
  });

  it("falls back to text/plain rather than to a type the CHECK would reject", () => {
    // `.js` guesses text/javascript and `.sql` guesses text/plain; only the
    // first is outside the page CHECK. An extension-less `README` has no guess.
    expect(kbContentType("a.js")).toBe("text/plain");
    expect(kbContentType("a.sql")).toBe("text/plain");
    expect(kbContentType("README")).toBe("text/plain");
    expect(kbContentType("a.qqq")).toBe("text/plain");
  });

  it("returns a value the page CHECK accepts for every admitted extension", () => {
    const CHECK = [
      "text/markdown",
      "text/plain",
      "text/csv",
      "application/json",
      "text/yaml",
      "text/xml",
    ];
    for (const path of ["a.py", "a.sh", "a.ipynb", "a.toml", "a.svg", "a.html"]) {
      expect(CHECK).toContain(kbContentType(path));
    }
  });
});

describe("kb/import-policy — strict UTF-8", () => {
  const bytes = (values: number[]): Uint8Array => Uint8Array.from(values);

  it("accepts UTF-8 text, including multi-byte prose", () => {
    expect(textDecodeProblem(Buffer.from("构建 说明 — ok", "utf8"))).toBeNull();
    expect(textDecodeProblem(Buffer.from("", "utf8"))).toBeNull();
  });

  it("names a legacy-encoded file instead of importing replacement characters", () => {
    // `0xff` starts no legal UTF-8 sequence; `toString("utf8")` would have
    // silently turned it into U+FFFD and imported the mojibake.
    expect(textDecodeProblem(bytes([0xff, 0xfe, 0x41]))).toContain(
      "not valid UTF-8 text",
    );
    expect(textDecodeProblem(bytes([0xc4, 0xe8]))).toContain(
      "not valid UTF-8 text",
    );
  });

  it("leaves a NUL byte to the walker, which owns that rule", () => {
    expect(textDecodeProblem(bytes([0x61, 0x00, 0x62]))).toBeNull();
  });
});
