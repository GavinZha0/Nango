import { describe, it, expect } from "vitest";
import {
  describeMissingSshScripts,
  findMissingSshScripts,
  parseSkillMd,
  rewriteScriptsOnSshInSkillMd,
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

  it("accepts any extension under scripts/ (runtime rejects non-.py/.sh)", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('scripts-on-ssh: ["probe.js", "probe.txt", "Makefile"]'),
    );
    expect(frontmatter.scriptsOnSsh).toEqual([
      "scripts/probe.js",
      "scripts/probe.txt",
      "scripts/Makefile",
    ]);
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

  it("allows sub-directories under scripts/", () => {
    const { frontmatter } = parseSkillMd(
      HEADER(
        'scripts-on-ssh: ["sub/probe.sh", "scripts/lib/check.py", "scripts/a/b/run.sh"]',
      ),
    );
    expect(frontmatter.scriptsOnSsh).toEqual([
      "scripts/sub/probe.sh",
      "scripts/lib/check.py",
      "scripts/a/b/run.sh",
    ]);
  });

  it("rejects hidden segments at any depth", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: [".probe.sh"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["scripts/.probe.sh"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["scripts/lib/.probe.sh"]')),
    ).toThrow(SkillParseError);
  });

  it("rejects empty path segments", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["scripts//probe.sh"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["scripts/lib/"]')),
    ).toThrow(SkillParseError);
  });

  it("treats a key with no value as an empty list", () => {
    const { frontmatter } = parseSkillMd(HEADER("scripts-on-ssh:"));
    expect(frontmatter.scriptsOnSsh).toEqual([]);
  });

  // The parse error is surfaced to skill authors in the editor, so the
  // wording is part of the contract — assert it, not just the class.
  it("reports which rule each rejection broke", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["probe.sh", "scripts/probe.sh"]')),
    ).toThrow('duplicate entry "scripts/probe.sh"');
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["scripts/lib/"]')),
    ).toThrow("must not contain empty");
    expect(() =>
      parseSkillMd(HEADER('scripts-on-ssh: ["../probe.sh"]')),
    ).toThrow("must be a relative path");
  });

  it("normalizes multiple mixed-form entries in declaration order", () => {
    const { frontmatter } = parseSkillMd(
      HEADER(
        'scripts-on-ssh: [probe.sh, scripts/run.py, lib/check.sh, Check.PY]',
      ),
    );
    expect(frontmatter.scriptsOnSsh).toEqual([
      "scripts/probe.sh",
      "scripts/run.py",
      "scripts/lib/check.sh",
      "scripts/Check.PY",
    ]);
  });
});

describe("rewriteScriptsOnSshInSkillMd", () => {
  it("renames a scalar declaration and keeps the rest of the document intact", () => {
    const before = HEADER("scripts-on-ssh: probe.sh");
    const { skillMd, changed } = rewriteScriptsOnSshInSkillMd(
      before,
      new Map([["scripts/probe.sh", "scripts/renamed.sh"]]),
    );

    expect(changed).toBe(true);
    expect(skillMd).toContain("body content");
    expect(parseSkillMd(skillMd).frontmatter.scriptsOnSsh).toEqual([
      "scripts/renamed.sh",
    ]);
  });

  it("rewrites inline arrays and preserves unrelated entries", () => {
    const before = HEADER('scripts-on-ssh: ["probe.sh", "other.py"]');
    const { skillMd } = rewriteScriptsOnSshInSkillMd(
      before,
      new Map([["scripts/probe.sh", "scripts/renamed.sh"]]),
    );

    expect(parseSkillMd(skillMd).frontmatter.scriptsOnSsh).toEqual([
      "scripts/renamed.sh",
      "scripts/other.py",
    ]);
  });

  it("removes an entry and drops the key line when the list becomes empty", () => {
    const before = HEADER('scripts-on-ssh: ["probe.sh"]');
    const { skillMd } = rewriteScriptsOnSshInSkillMd(
      before,
      new Map([["scripts/probe.sh", null]]),
    );

    expect(skillMd).not.toMatch(/^scripts-on-ssh:/m);
    expect(parseSkillMd(skillMd).frontmatter.scriptsOnSsh).toBeUndefined();
  });

  it("keeps the alias key spelling", () => {
    const before = HEADER('scriptsOnSsh: ["probe.sh"]');
    const { skillMd } = rewriteScriptsOnSshInSkillMd(
      before,
      new Map([["scripts/probe.sh", "scripts/renamed.sh"]]),
    );

    expect(skillMd).toContain('scriptsOnSsh: ["scripts/renamed.sh"]');
  });

  it("synchronizes a rename to a non-executable extension", () => {
    const before = HEADER("scripts-on-ssh: probe.sh");
    const { skillMd } = rewriteScriptsOnSshInSkillMd(
      before,
      new Map([["scripts/probe.sh", "scripts/probe.txt"]]),
    );

    expect(parseSkillMd(skillMd).frontmatter.scriptsOnSsh).toEqual([
      "scripts/probe.txt",
    ]);
  });

  it("is a no-op when the declared path is absent", () => {
    const before = HEADER("scripts-on-ssh: probe.sh");
    const result = rewriteScriptsOnSshInSkillMd(
      before,
      new Map([["scripts/other.sh", "scripts/renamed.sh"]]),
    );

    expect(result).toEqual({ skillMd: before, changed: false });
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
