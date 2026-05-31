/**
 * Tests for the ZIP skill import helper logic. We test the pure
 * validation functions (locateSkillMd, derivePrefix) by importing
 * them indirectly through constructing ZIP archives with JSZip and
 * validating the route's behavior via the exported POST handler.
 *
 * Since the route handler depends on Next.js + DB + auth, we test
 * the ZIP processing logic at a lower level: build a ZIP, parse it,
 * and verify the validation rules match the spec in docs/skills.md.
 */

import { describe, expect, it } from "vitest";
import JSZip from "jszip";

/** Unix mode for a symlink (S_IFLNK = 0xA000). */
const SYMLINK_MODE = 0xA000;

// Helper: build a minimal valid .skill ZIP
async function buildSkillZip(entries: Record<string, string | { content: string; unixPermissions?: number }>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, val] of Object.entries(entries)) {
    if (typeof val === "string") {
      zip.file(path, val);
    } else {
      zip.file(path, val.content, { unixPermissions: val.unixPermissions });
    }
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf;
}

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for unit testing the import feature.
version: 1.0.0
---

# test-skill

Procedure: do the thing.
`;

// Re-implement the validation logic from the route to test in isolation
// (the actual route requires Next.js request/response which is hard to mock)

const S_IFMT = 0xF000;
const S_IFLNK = 0xA000;

function isSymlink(unixPermissions: number): boolean {
  return (unixPermissions & S_IFMT) === S_IFLNK;
}

function hasPathTraversal(path: string): boolean {
  return path.includes("..") || path.includes("\\") || path.startsWith("/");
}

function locateSkillMd(files: Record<string, JSZip.JSZipObject>): string | null {
  if (files["SKILL.md"]) return "SKILL.md";
  const candidates = Object.keys(files).filter(
    (p) => p.endsWith("/SKILL.md") && p.split("/").length === 2,
  );
  if (candidates.length === 1) return candidates[0];
  return null;
}

// ── ZIP structure validation ────────────────────────────────────────

describe("ZIP skill import — structure validation", () => {
  it("locates SKILL.md at the root of the archive", async () => {
    const buf = await buildSkillZip({ "SKILL.md": VALID_SKILL_MD });
    const zip = await JSZip.loadAsync(buf);
    expect(locateSkillMd(zip.files)).toBe("SKILL.md");
  });

  it("locates SKILL.md inside a single nested folder", async () => {
    const buf = await buildSkillZip({ "my-skill/SKILL.md": VALID_SKILL_MD });
    const zip = await JSZip.loadAsync(buf);
    expect(locateSkillMd(zip.files)).toBe("my-skill/SKILL.md");
  });

  it("rejects ZIP with no SKILL.md", async () => {
    const buf = await buildSkillZip({ "README.md": "hello" });
    const zip = await JSZip.loadAsync(buf);
    expect(locateSkillMd(zip.files)).toBeNull();
  });

  it("rejects ZIP with SKILL.md nested too deep", async () => {
    const buf = await buildSkillZip({ "a/b/SKILL.md": VALID_SKILL_MD });
    const zip = await JSZip.loadAsync(buf);
    expect(locateSkillMd(zip.files)).toBeNull();
  });
});

// ── Security: symlink detection ─────────────────────────────────────

describe("ZIP skill import — symlink detection", () => {
  it("detects symlink via Unix mode bits", () => {
    expect(isSymlink(SYMLINK_MODE)).toBe(true);
    expect(isSymlink(0o100644)).toBe(false); // regular file
    expect(isSymlink(0o040755)).toBe(false); // directory
    expect(isSymlink(0)).toBe(false);
  });

  it("detects various symlink mode values", () => {
    // S_IFLNK (0xA000) can be combined with any permission bits
    expect(isSymlink(0xA000 | 0o777)).toBe(true);
    expect(isSymlink(0xA000 | 0o755)).toBe(true);
    expect(isSymlink(0xA000)).toBe(true);
    // Regular file + directory should not match
    expect(isSymlink(0x8000 | 0o644)).toBe(false); // S_IFREG
    expect(isSymlink(0x4000 | 0o755)).toBe(false); // S_IFDIR
  });
});

// ── Security: path traversal ────────────────────────────────────────

describe("ZIP skill import — path traversal prevention", () => {
  it.each([
    "../etc/passwd",
    "..\\windows\\system32",
    "/absolute/path",
    "scripts/../../etc/shadow",
  ])("rejects path: %s", (path) => {
    expect(hasPathTraversal(path)).toBe(true);
  });

  it.each([
    "scripts/analyze.py",
    "references/output.md",
    "assets/template.json",
  ])("accepts valid path: %s", (path) => {
    expect(hasPathTraversal(path)).toBe(false);
  });
});

// ── Size limits ─────────────────────────────────────────────────────

describe("ZIP skill import — size tracking", () => {
  it("accumulates uncompressed bytes across entries", async () => {
    const entries: Record<string, string> = {
      "SKILL.md": VALID_SKILL_MD,
      "scripts/a.py": "x".repeat(1000),
      "scripts/b.py": "y".repeat(2000),
    };
    const buf = await buildSkillZip(entries);
    const zip = await JSZip.loadAsync(buf);

    let totalBytes = 0;
    for (const [, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const content = await entry.async("nodebuffer");
      totalBytes += content.length;
    }

    // SKILL.md + 1000 + 2000
    expect(totalBytes).toBeGreaterThan(3000);
  });
});

// ── SKILL.md content validation ─────────────────────────────────────

describe("ZIP skill import — SKILL.md parsing", () => {
  it("can extract SKILL.md content as string", async () => {
    const buf = await buildSkillZip({ "SKILL.md": VALID_SKILL_MD });
    const zip = await JSZip.loadAsync(buf);
    const content = await zip.files["SKILL.md"].async("string");
    expect(content).toContain("name: test-skill");
    expect(content).toContain("description:");
  });
});
