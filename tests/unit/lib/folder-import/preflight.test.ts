import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/http/route-handlers";
import {
  assertBodyWithinCap,
  assertNoBlocked,
  assertNoPathKindClash,
  walkEntries,
  type ImportCaps,
  type WalkPolicy,
} from "@/lib/folder-import/preflight";
import type { FolderEntry } from "@/lib/folder-import/manifest";

const CAPS: ImportCaps = {
  maxFiles: 3,
  maxFileBytes: 100,
  maxTotalBytes: 200,
};

/** Everything is text; no path rules. */
const PERMISSIVE: WalkPolicy = {
  caps: CAPS,
  admit: () => ({ action: "allow-text" }),
};

function entry(path: string, text: string): FolderEntry {
  return { path, contentBase64: Buffer.from(text).toString("base64") };
}

function requestWithLength(contentLength: string): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-length": contentLength },
  });
}

describe("assertBodyWithinCap", () => {
  it("rejects an oversized body before it is buffered", () => {
    expect(() => assertBodyWithinCap(requestWithLength("20000000"), 16 * 1024 * 1024)).toThrow(ApiError);
    try {
      assertBodyWithinCap(requestWithLength("20000000"), 16 * 1024 * 1024);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(413);
      expect((err as ApiError).message).toBe("Upload exceeds 16 MB.");
    }
  });

  it("passes a body within the cap, including a missing Content-Length", () => {
    expect(() => assertBodyWithinCap(requestWithLength("1024"), 16 * 1024 * 1024)).not.toThrow();
    expect(() => assertBodyWithinCap(new Request("http://localhost/api/x"), 1024)).not.toThrow();
  });
});

describe("walkEntries", () => {
  it("decodes admitted entries in manifest order", () => {
    const out = walkEntries(
      [entry("b.md", "two"), entry("a.md", "one")],
      PERMISSIVE,
    );
    expect(out.files.map((f) => f.path)).toEqual(["b.md", "a.md"]);
    expect(out.files[1].content.toString("utf-8")).toBe("one");
    expect(out.skipped).toEqual([]);
    expect(out.blocked).toEqual([]);
  });

  it("fails fast on a traversal path before consulting the policy", () => {
    const admit = vi.fn(PERMISSIVE.admit);
    expect(() =>
      walkEntries([entry("../escape.md", "x")], { ...PERMISSIVE, admit }),
    ).toThrow(/Invalid path in upload: \.\.\/escape\.md/);
    expect(admit).not.toHaveBeenCalled();
  });

  it("separates skipped noise from blocked content", () => {
    const out = walkEntries(
      [
        entry(".DS_Store", "junk"),
        entry("node_modules/pkg/index.js", "junk"),
        entry("guide.md", "fine"),
      ],
      {
        caps: CAPS,
        admit: (path) =>
          path.startsWith(".") || path.includes("node_modules")
            ? { action: "ignore", reason: "noise or dotfile" }
            : { action: "allow-text" },
      },
    );
    expect(out.skipped).toEqual([".DS_Store", "node_modules/pkg/index.js"]);
    expect(out.files.map((f) => f.path)).toEqual(["guide.md"]);
  });

  it("blocks policy refusals and subsystem path violations with their reasons", () => {
    const out = walkEntries([entry("setup.exe", "bin"), entry("bad name.md", "x")], {
      caps: CAPS,
      admit: (path) =>
        path.endsWith(".exe")
          ? { action: "block", reason: "executable file" }
          : { action: "allow-text" },
      validatePath: (path) => (path.includes(" ") ? "name must not contain spaces" : null),
    });
    expect(out.blocked).toEqual([
      { path: "setup.exe", reason: "executable file" },
      { path: "bad name.md", reason: "name must not contain spaces" },
    ]);
    expect(out.files).toEqual([]);
  });

  it("defaults a policy block without a reason to an unsupported-type message", () => {
    const out = walkEntries([entry("mystery.xyz", "x")], {
      caps: CAPS,
      admit: () => ({ action: "block" }),
    });
    expect(out.blocked[0].reason).toBe("unsupported file type");
  });

  it("enforces the file-count cap before decoding", () => {
    const entries = [entry("a.md", "1"), entry("b.md", "2"), entry("c.md", "3"), entry("d.md", "4")];
    expect(() => walkEntries(entries, PERMISSIVE)).toThrow(
      ApiError,
    );
    expect(() => walkEntries(entries, PERMISSIVE)).toThrow(
      "Upload exceeds 3 file limit.",
    );
  });

  it("enforces per-file and total byte caps on decoded bytes", () => {
    const oversized = {
      path: "big.md",
      contentBase64: Buffer.alloc(101, 0x61).toString("base64"),
    };
    expect(() => walkEntries([oversized], PERMISSIVE)).toThrow(
      /File big\.md exceeds .* KB limit\./,
    );

    const three = [
      Buffer.alloc(80, 0x61).toString("base64"),
      Buffer.alloc(80, 0x61).toString("base64"),
      Buffer.alloc(80, 0x61).toString("base64"),
    ];
    expect(() =>
      walkEntries(
        three.map((contentBase64, i) => ({ path: `f${i}.md`, contentBase64 })),
        PERMISSIVE,
      ),
    ).toThrow(/Total size exceeds .* MB limit\./);
  });

  it("blocks text that carries NUL bytes and forwards images to the content check", () => {
    const actions: string[] = [];
    const out = walkEntries(
      [
        { path: "note.md", contentBase64: Buffer.from([0x61, 0x00]).toString("base64") },
        { path: "logo.png", contentBase64: Buffer.from("nope").toString("base64") },
      ],
      {
        caps: CAPS,
        admit: (path) =>
          path.endsWith(".png") ? { action: "allow-image" } : { action: "allow-text" },
        validateContent: (path, _content, action) => {
          actions.push(action);
          return action === "allow-image" ? `${path} is not a real image` : null;
        },
      },
    );
    expect(out.blocked).toEqual([
      { path: "note.md", reason: "Text files cannot contain NUL bytes." },
      { path: "logo.png", reason: "logo.png is not a real image" },
    ]);
    expect(actions).toEqual(["allow-image"]);
  });

  it("measures the total only over decoded entries", () => {
    // QUIRK: noise is dropped before its bytes are decoded, so a folder padded
    // with caches can still import when the real sources fit the budget.
    const out = walkEntries(
      [
        entry("a.md", "x".repeat(90)),
        { path: "debug.log", contentBase64: Buffer.alloc(500, 0x61).toString("base64") },
      ],
      {
        caps: CAPS,
        admit: (path) =>
          path.endsWith(".log") ? { action: "ignore", reason: "generated build or tool artifact" } : { action: "allow-text" },
      },
    );
    expect(out.files).toHaveLength(1);
    expect(out.skipped).toEqual(["debug.log"]);
  });
});

describe("assertNoBlocked", () => {
  it("passes a clean walk", () => {
    expect(() => assertNoBlocked([])).not.toThrow();
  });

  it("names each refused path with its reason, capped at twenty", () => {
    const blocked = Array.from({ length: 22 }, (_, i) => ({
      path: `f${i}.exe`,
      reason: "executable file",
    }));
    try {
      assertNoBlocked(blocked);
      throw new Error("expected assertNoBlocked to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const message = (err as ApiError).message;
      expect(message).toContain('"f0.exe" (executable file)');
      expect(message).toContain("and 2 more");
      expect(message).not.toContain("f21.exe");
    }
  });
});

describe("assertNoPathKindClash", () => {
  it("refuses a path that is both a file and a folder", () => {
    expect(() =>
      assertNoPathKindClash([
        { path: "notes", content: Buffer.from("x") },
        { path: "notes/guide.md", content: Buffer.from("y") },
      ]),
    ).toThrow('Upload contains both a file and a folder named "notes".');
  });

  it("accepts disjoint paths", () => {
    expect(() =>
      assertNoPathKindClash([
        { path: "notes.md", content: Buffer.from("x") },
        { path: "notes/guide.md", content: Buffer.from("y") },
      ]),
    ).not.toThrow();
  });
});
