import { describe, expect, it } from "vitest";

import {
  describeMissingDeclaredScripts,
  findMissingDeclaredScripts,
  parseSkillMd,
  SkillParseError,
} from "@/lib/skills/parser";

const HEADER = (lines: string): string => `---
name: sales-report
description: A skill with SQL reports declared for run_skill_sql_script.
${lines}
---

body content
`;

describe("parseSkillMd: scripts-on-db", () => {
  it("returns undefined when the key is absent", () => {
    expect(parseSkillMd(HEADER("version: 1.0.0")).frontmatter.scriptsOnDb)
      .toBeUndefined();
  });

  it("parses and normalizes canonical entries, including subfolders", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('scripts-on-db: ["sales.sql", "reports/quarterly.sql"]'),
    );

    expect(frontmatter.scriptsOnDb).toEqual([
      "scripts/sales.sql",
      "scripts/reports/quarterly.sql",
    ]);
    expect(frontmatter.extras).not.toHaveProperty("scripts-on-db");
  });

  it("supports the snake_case and camelCase aliases", () => {
    expect(
      parseSkillMd(HEADER("scripts_on_db: [reports/a.sql]")).frontmatter
        .scriptsOnDb,
    ).toEqual(["scripts/reports/a.sql"]);
    expect(
      parseSkillMd(HEADER("scriptsOnDb: [reports/b.sql]")).frontmatter
        .scriptsOnDb,
    ).toEqual(["scripts/reports/b.sql"]);
  });

  it("rejects non-.sql entries", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-db: ["reports/a.txt"]')),
    ).toThrow(/must have a \.sql extension/);
  });

  it("rejects traversal, hidden, empty, and duplicate entries", () => {
    expect(() =>
      parseSkillMd(HEADER('scripts-on-db: ["../sales.sql"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-db: ["reports/.hidden.sql"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(HEADER('scripts-on-db: ["reports//sales.sql"]')),
    ).toThrow(SkillParseError);
    expect(() =>
      parseSkillMd(
        HEADER('scripts-on-db: ["sales.sql", "scripts/sales.sql"]'),
      ),
    ).toThrow(/duplicate entry "scripts\/sales.sql"/);
  });
});

describe("declared DB script diagnostics", () => {
  it("finds missing SQL files", () => {
    expect(
      findMissingDeclaredScripts(
        ["scripts/a.sql", "scripts/reports/b.sql"],
        ["scripts/a.sql"],
      ),
    ).toEqual(["scripts/reports/b.sql"]);
  });

  it("names scripts-on-db in the editor message", () => {
    const message = describeMissingDeclaredScripts(
      ["scripts/reports/b.sql"],
      ["scripts/a.sql"],
      "scripts-on-db",
    );
    expect(message).toMatch(/scripts-on-db declares missing/);
    expect(message).toMatch(/scripts\/reports\/b\.sql/);
  });
});
