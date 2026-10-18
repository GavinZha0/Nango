import { describe, expect, it } from "vitest";

import {
  syncDeclarationForRename,
  syncDeclarationsForDelete,
  syncDeclarationsForFolderRename,
} from "@/lib/skills/declaration-sync";
import { parseSkillMd } from "@/lib/skills/parser";

function skillMd(declaration: string): string {
  return `---\nname: test-skill\ndescription: A skill used by declaration sync tests.\n${declaration}\n---\n\nbody\n`;
}

describe("syncDeclarationForRename", () => {
  it("rewrites a declared script path", () => {
    const result = syncDeclarationForRename(
      skillMd("scripts-on-ssh: probe.sh"),
      "scripts/probe.sh",
      "scripts/renamed.sh",
    );

    expect(result.changed).toBe(true);
    expect(parseSkillMd(result.skillMd).frontmatter.scriptsOnSsh).toEqual([
      "scripts/renamed.sh",
    ]);
  });

  it("warns when the target is not executable but still syncs", () => {
    const result = syncDeclarationForRename(
      skillMd("scripts-on-ssh: probe.sh"),
      "scripts/probe.sh",
      "scripts/probe.txt",
    );

    expect(result.changed).toBe(true);
    expect(result.warning).toMatch(/not executable/);
    expect(parseSkillMd(result.skillMd).frontmatter.scriptsOnSsh).toEqual([
      "scripts/probe.txt",
    ]);
  });

  it("reports a conflict when the target is already declared", () => {
    const result = syncDeclarationForRename(
      skillMd('scripts-on-ssh: ["probe.sh", "other.sh"]'),
      "scripts/probe.sh",
      "scripts/other.sh",
    );

    expect(result.conflict).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("is a no-op for an undeclared path", () => {
    const before = skillMd("scripts-on-ssh: probe.sh");
    const result = syncDeclarationForRename(
      before,
      "scripts/other.sh",
      "scripts/renamed.sh",
    );

    expect(result).toEqual({ skillMd: before, changed: false });
  });
});

describe("syncDeclarationsForFolderRename", () => {
  it("rewrites every declaration under the renamed folder", () => {
    const result = syncDeclarationsForFolderRename(
      skillMd('scripts-on-ssh: ["lib/a.sh", "lib/sub/b.py", "other.sh"]'),
      "scripts/lib",
      "scripts/util",
    );

    expect(result.changed).toBe(true);
    expect(parseSkillMd(result.skillMd).frontmatter.scriptsOnSsh).toEqual([
      "scripts/util/a.sh",
      "scripts/util/sub/b.py",
      "scripts/other.sh",
    ]);
  });

  it("reports a conflict when the target already has a declaration", () => {
    const result = syncDeclarationsForFolderRename(
      skillMd('scripts-on-ssh: ["lib/a.sh", "util/a.sh"]'),
      "scripts/lib",
      "scripts/util",
    );

    expect(result.conflict).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("is a no-op when no declaration lives under the folder", () => {
    const before = skillMd("scripts-on-ssh: other.sh");
    const result = syncDeclarationsForFolderRename(
      before,
      "scripts/lib",
      "scripts/util",
    );

    expect(result).toEqual({ skillMd: before, changed: false });
  });
});

describe("syncDeclarationsForDelete", () => {
  it("removes declarations for deleted files", () => {
    const result = syncDeclarationsForDelete(
      skillMd('scripts-on-ssh: ["a.sh", "b.py"]'),
      ["scripts/a.sh", "scripts/b.py"],
    );

    expect(result.changed).toBe(true);
    expect(result.skillMd).not.toMatch(/^scripts-on-ssh:/m);
  });

  it("leaves unrelated declarations alone", () => {
    const before = skillMd('scripts-on-ssh: ["a.sh", "b.py"]');
    const result = syncDeclarationsForDelete(before, ["scripts/a.sh"]);

    expect(parseSkillMd(result.skillMd).frontmatter.scriptsOnSsh).toEqual([
      "scripts/b.py",
    ]);
  });
});
