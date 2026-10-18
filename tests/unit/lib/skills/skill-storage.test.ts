import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
  };
});

import {
  InvalidSkillPathError,
  validateSkillFilePath,
  guessContentType,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SKILL,
  MAX_TOTAL_BYTES_PER_SKILL,
} from "@/lib/skills/storage";

describe("validateSkillFilePath", () => {
  describe("accepts", () => {
    it.each([
      "references/output.md",
      "references/sub/nested.md",
      "scripts/run.py",
      "assets/logo.png",
      "assets/folder/file.html",
      "evals/case1.json",
      "references/a.b.c.txt",
      "references/a-b_c.md",
      // Any top-level folder name is legal — authors use whatever fits.
      "lib/helper.py",
      "rules/style.md",
      "ROOT/file.md",
      "config/settings.json",
      "src/file.md",
      "My-Templates/deck.md",
      // Root-level helper files (e.g. LICENSE) are valid.
      "LICENSE",
      "notes.md",
      "README",
    ])("valid path: %s", (p) => {
      expect(() => validateSkillFilePath(p)).not.toThrow();
    });
  });

  describe("rejects", () => {
    it.each([
      "",
      "/absolute/path.md",
      "..\\windows.md",
      "../parent.md",
      "references/../escape.md",
      "references/.hidden.md",
      "references/sub/..parent.md",
      "references\\back.md",
      // The synthetic root SKILL.md lives in its own column.
      "SKILL.md",
      "skill.md",
      // Empty filename after subdir
      "references/",
      "references/sub/",
    ])("invalid path: %s", (p) => {
      expect(() => validateSkillFilePath(p)).toThrow(InvalidSkillPathError);
    });

    it("rejects oversize paths", () => {
      const huge = `references/${"a".repeat(300)}`;
      expect(() => validateSkillFilePath(huge)).toThrow(InvalidSkillPathError);
    });
  });
});

describe("skill storage caps (config-backed)", () => {
  it("MAX_FILE_BYTES returns 256 KB default", () => {
    expect(MAX_FILE_BYTES()).toBe(256 * 1024);
  });

  it("MAX_FILES_PER_SKILL returns 100 default", () => {
    expect(MAX_FILES_PER_SKILL()).toBe(100);
  });

  it("MAX_TOTAL_BYTES_PER_SKILL returns 10 MB default", () => {
    expect(MAX_TOTAL_BYTES_PER_SKILL()).toBe(10 * 1024 * 1024);
  });
});

describe("guessContentType", () => {
  it("maps image extensions so the editor can preview them", () => {
    expect(guessContentType("assets/logo.png")).toBe("image/png");
    expect(guessContentType("assets/photo.jpeg")).toBe("image/jpeg");
    expect(guessContentType("assets/photo.jpg")).toBe("image/jpeg");
    expect(guessContentType("assets/anim.gif")).toBe("image/gif");
    expect(guessContentType("assets/modern.webp")).toBe("image/webp");
  });

  it("maps text and document extensions", () => {
    expect(guessContentType("references/guide.md")).toBe("text/markdown");
    expect(guessContentType("scripts/run.py")).toBe("text/x-python");
    expect(guessContentType("scripts/probe.sh")).toBe("text/x-shellscript");
    expect(guessContentType("evals/case.json")).toBe("application/json");
    expect(guessContentType("assets/spec.pdf")).toBe("application/pdf");
  });

  it("is case-insensitive on the extension", () => {
    expect(guessContentType("assets/LOGO.PNG")).toBe("image/png");
    expect(guessContentType("assets/Photo.JpEg")).toBe("image/jpeg");
  });

  it("reads the extension off the basename, not a dotted directory", () => {
    expect(guessContentType("assets/v1.2/logo.png")).toBe("image/png");
    // The directory looks like it has an extension; the file has none.
    expect(guessContentType("assets/v1.2/README")).toBeNull();
  });

  it("returns null for unknown or absent extensions", () => {
    expect(guessContentType("assets/mystery.bin")).toBeNull();
    expect(guessContentType("assets/archive.tar.gz")).toBeNull();
    expect(guessContentType("references/README")).toBeNull();
    expect(guessContentType("references/trailing.")).toBeNull();
    // Dotfiles are rejected by validateSkillFilePath, but the guesser must not
    // treat the leading dot as an extension separator.
    expect(guessContentType("assets/.env")).toBeNull();
  });

  it("never returns a type the browser would render as markup", () => {
    // CONTRACT: these reach the editor as a `data:` URL offered both as an
    // <img src> and a download href, so they are excluded by design.
    expect(guessContentType("assets/page.html")).toBeNull();
    expect(guessContentType("assets/page.htm")).toBeNull();
    expect(guessContentType("assets/icon.svg")).toBeNull();
  });
});
