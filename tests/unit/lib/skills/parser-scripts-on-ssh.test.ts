import { describe, it, expect } from "vitest";
import {
  describeMissingSshScripts,
  findMissingSshScripts,
  parseSkillMd,
  SkillParseError,
} from "@/lib/skills/parser";

const HEADER = (lines: string): string => `---
name: test-skill
description: A test skill for scripts-on-ssh frontmatter parsing.
${lines}
---

body content
`;

describe("parseSkillMd: scripts-on-ssh", () => {
  it("returns undefined when the key is absent", () => {
    const { frontmatter } = parseSkillMd(HEADER("version: 1.0.0"));
    expect(frontmatter.scriptsOnSsh).toBeUndefined();
  });

  it("parses canonical scripts-on-ssh and normalizes to scripts/<file>", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('scripts-on-ssh: ["probe.sh", "scripts/check.py"]'),
    );
    expect(frontmatter.scriptsOnSsh).toEqual(["scripts/probe.sh", "scripts/check.py"]);
    expect(frontmatter.extras).not.toHaveProperty("scripts-on-ssh");
  });

  it("supports scripts_on_ssh snake_case alias", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('scripts_on_ssh: ["probe.sh"]'),
    );
    expect(frontmatter.scriptsOnSsh).toEqual(["scripts/probe.sh"]);
    expect(frontmatter.extras).not.toHaveProperty("scripts_on_ssh");
  });

  it("supports scriptsOnSsh camelCase alias", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('scriptsOnSsh: ["probe.py"]'),
    );
    expect(frontmatter.scriptsOnSsh).toEqual(["scripts/probe.py"]);
    expect(frontmatter.extras).not.toHaveProperty("scriptsOnSsh");
  });

  it("normalizes a single bare value into a one-element array", () => {
    const { frontmatter } = parseSkillMd(HEADER("scripts-on-ssh: probe.sh"));
    expect(frontmatter.scriptsOnSsh).toEqual(["scripts/probe.sh"]);
  });

  it("handles explicit empty list", () => {
    const { frontmatter } = parseSkillMd(HEADER("scripts-on-ssh: []"));
    expect(frontmatter.scriptsOnSsh).toEqual([]);
  });

  it("rejects duplicate entries (even if one is bare and one has scripts/ prefix)", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["probe.sh", "scripts/probe.sh"]')),
    ).toThrow(SkillParseError);
  });

  it("rejects unsupported extensions", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["probe.js"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["probe.txt"]')),
    ).toThrow(SkillParseError);
  });

  it("rejects path traversal attempts", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["../probe.sh"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["/probe.sh"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["scripts\\\\probe.sh"]')),
    ).toThrow(SkillParseError);
  });

  it("rejects sub-directories under scripts/", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["sub/probe.sh"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["scripts/sub/probe.sh"]')),
    ).toThrow(SkillParseError);
  });

  it("rejects hidden files", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: [".probe.sh"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["scripts/.probe.sh"]')),
    ).toThrow(SkillParseError);
  });

  it("treats a key with no value as an empty list", () => {
    const { frontmatter } = parseSkillMd(HEADER("scripts-on-ssh:"));
    expect(frontmatter.scriptsOnSsh).toEqual([]);
  });

  // The parse error is surfaced to skill authors in the editor, so the
  // wording is part of the contract — assert it, not just the class.
  it("reports which rule each rejection broke", () => {
    expect(() => parseSkillMd(HEADER('scripts-on-ssh: ["probe.txt"]'))).toThrow(
      'unsupported extension ".txt"',
    );
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["probe.sh", "scripts/probe.sh"]')),
    ).toThrow('duplicate entry "scripts/probe.sh"');
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["sub/probe.sh"]')),
    ).toThrow("must be a direct child of scripts/");
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["../probe.sh"]')),
    ).toThrow("must be a relative path");
  });

  it("normalizes multiple mixed-form entries in declaration order", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('scripts-on-ssh: [probe.sh, scripts/run.py, Check.PY]'),
    );
    expect(frontmatter.scriptsOnSsh).toEqual([
      "scripts/probe.sh",
      "scripts/run.py",
      "scripts/Check.PY",
    ]);
  });
});

describe("findMissingSshScripts / describeMissingSshScripts", () => {
  it("returns declared entries with no backing path, in declaration order", () => {
    expect(
      findMissingSshScripts(
        ["scripts/b.sh", "scripts/a.py", "scripts/c.sh"],
        ["scripts/a.py", "references/notes.md"],
      ),
    ).toEqual(["scripts/b.sh", "scripts/c.sh"]);
  });

  it("returns nothing when every entry is backed", () => {
    expect(
      findMissingSshScripts(["scripts/a.sh"], ["scripts/a.sh", "scripts/b.sh"]),
    ).toEqual([]);
  });

  it("treats an empty path set as every entry missing", () => {
    expect(findMissingSshScripts(["scripts/a.sh"], [])).toEqual(["scripts/a.sh"]);
  });

  it("names the available scripts so a typo is self-evident", () => {
    const message = describeMissingSshScripts(
      ["scripts/probe.sh"],
      ["scripts/probes.sh", "references/notes.md"],
    );
    expect(message).toMatch(/declares missing file\(s\): scripts\/probe\.sh/);
    expect(message).toMatch(/Present under scripts\/: scripts\/probes\.sh/);
    expect(message).not.toMatch(/references\/notes\.md/);
  });

  it("says so plainly when the skill has no scripts at all", () => {
    const message = describeMissingSshScripts(
      ["scripts/probe.sh"],
      ["references/notes.md"],
    );
    expect(message).toMatch(/no files under scripts\//);
  });
});
