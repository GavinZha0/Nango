import { describe, expect, it } from "vitest";

import {
  MAX_FOLDER_DEPTH,
  MAX_PATH_CHARS,
} from "@/lib/kb/limits";
import {
  ancestorFolders,
  distinctFolders,
  folderDepth,
  folderOf,
  folderProblem,
  isUnderFolder,
  pathProblem,
  rewriteFolderPrefix,
  topLevelFolderCount,
} from "@/lib/kb/paths";

describe("kb/paths — page path legality", () => {
  it("accepts prose: CJK, spaces, dots and dashes all name a page", () => {
    for (const path of [
      "install.md",
      "chapter-01/裸机安装.md",
      "team notes/2026 复盘 final",
      "a.b.c",
      "v1.2.3-rc1/config",
    ]) {
      expect(pathProblem(path)).toBeNull();
    }
  });

  it("refuses the shapes that make a segment ambiguous", () => {
    expect(pathProblem("")).toBe("must not be empty");
    expect(pathProblem("/install")).toBe("must not contain an empty segment");
    expect(pathProblem("install/")).toBe("must not contain an empty segment");
    expect(pathProblem("a//b")).toBe("must not contain an empty segment");
    expect(pathProblem("./install")).toBe('must not contain the segment "."');
    expect(pathProblem("../secrets")).toBe(
      'must not contain the segment ".."',
    );
    expect(pathProblem("a/../b")).toBe('must not contain the segment ".."');
  });

  it("refuses bytes that cannot survive a prompt line or a URL segment", () => {
    // Control characters cover NUL, tab and newline — the ones a paste brings in.
    expect(pathProblem("bad\u0000name")).toBe(
      "must not contain control characters",
    );
    expect(pathProblem("bad\tname")).toBe("must not contain control characters");
    expect(pathProblem("a/b\nc")).toBe("must not contain control characters");
    expect(pathProblem(`bad${String.fromCharCode(0x7f)}name`)).toBe(
      "must not contain control characters",
    );
  });

  it("caps the path length that the agent echoes back as a handle", () => {
    const at = "d".repeat(MAX_PATH_CHARS);
    const over = "d".repeat(MAX_PATH_CHARS + 1);
    expect(pathProblem(at)).toBeNull();
    expect(pathProblem(over)).toBe(`must not exceed ${MAX_PATH_CHARS} characters`);
  });

  it("caps folder depth below the page, so a leaf is one segment past the limit", () => {
    const deepest = "a/b/leaf"; // 2 folder levels + leaf
    expect(pathProblem(deepest)).toBeNull();
    expect(pathProblem("a/b/c/leaf")).toBe(
      `nests ${MAX_FOLDER_DEPTH + 1} folder levels; the limit is ${MAX_FOLDER_DEPTH}`,
    );
  });
});

describe("kb/paths — folder prefix legality", () => {
  it("treats the empty prefix as the collection root, which is legal", () => {
    expect(folderProblem("")).toBeNull();
    expect(folderDepth("")).toBe(0);
  });

  it("shares the segment rules with page paths", () => {
    expect(folderProblem("a//b")).toBe("must not contain an empty segment");
    expect(folderProblem("..")).toBe('must not contain the segment ".."');
    expect(folderProblem("a\u0000b")).toBe("must not contain control characters");
  });

  it("applies the same depth cap the prefix itself spans", () => {
    expect(folderProblem("a/b")).toBeNull();
    expect(folderProblem("a/b/c")).toBe(
      `nests ${MAX_FOLDER_DEPTH + 1} folder levels; the limit is ${MAX_FOLDER_DEPTH}`,
    );
  });
});

describe("kb/paths — folder derivation", () => {
  it("reads a page's folder as everything before the last segment", () => {
    expect(folderOf("install")).toBe("");
    expect(folderOf("chapter-01/install")).toBe("chapter-01");
    expect(folderOf("chapter-01/images/build")).toBe("chapter-01/images");
    expect(folderDepth("chapter-01/images")).toBe(2);
  });

  it("lists every folder a path passes through, outermost first", () => {
    expect(ancestorFolders("install")).toEqual([]);
    expect(ancestorFolders("a/b/c")).toEqual(["a", "a/b"]);
  });

  it("deduplicates implied folders with parents before children", () => {
    expect(
      distinctFolders(["chapter-10/a", "chapter-10/b", "chapter-2/a", "loose"]),
    ).toEqual(["chapter-2", "chapter-10"]);
    expect(distinctFolders(["a/b/c", "a/b/d", "x/y/leaf"])).toEqual([
      "a",
      "a/b",
      "x",
      "x/y",
    ]);
    expect(distinctFolders([])).toEqual([]);
  });

  it("counts only level-1 folders, which is what the panel prints", () => {
    expect(
      topLevelFolderCount(["a/1", "a/2", "a/b/1", "c/1", "loose"]),
    ).toBe(2);
    expect(topLevelFolderCount(["loose", "other"])).toBe(0);
  });

  it("requires a real prefix boundary, never a string that merely starts alike", () => {
    expect(isUnderFolder("chapter-01/install", "chapter-01")).toBe(true);
    expect(isUnderFolder("chapter-01-images/install", "chapter-01")).toBe(false);
    expect(isUnderFolder("chapter-01", "chapter-01")).toBe(false);
    // The root is not a folder, so it never claims the whole collection.
    expect(isUnderFolder("chapter-01/install", "")).toBe(false);
  });
});

describe("kb/paths — subtree rewrite", () => {
  it("rewrites the prefix and leaves the rest of the path untouched", () => {
    expect(rewriteFolderPrefix("a/b/leaf", "a", "x")).toBe("x/b/leaf");
    expect(rewriteFolderPrefix("a/b/leaf", "a/b", "x/y")).toBe("x/y/leaf");
  });

  it("lifts a subtree to the collection root by rewriting to the empty prefix", () => {
    expect(rewriteFolderPrefix("a/b/leaf", "a", "")).toBe("b/leaf");
  });

  it("returns paths outside the folder unchanged so a caller can map the whole set", () => {
    expect(rewriteFolderPrefix("other/leaf", "a", "x")).toBe("other/leaf");
    expect(rewriteFolderPrefix("a-variant/leaf", "a", "x")).toBe("a-variant/leaf");
  });
});
