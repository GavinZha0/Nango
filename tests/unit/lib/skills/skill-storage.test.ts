import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config", () => ({
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

import {
  InvalidSkillPathError,
  validateSkillFilePath,
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
      "ROOT/file.md",
      "src/file.md",
      "references/.hidden.md",
      "references/sub/..parent.md",
      "references\\back.md",
      // top-level outside whitelist
      "config/file.md",
      // empty filename after subdir
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
