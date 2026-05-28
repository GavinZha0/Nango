import { describe, it, expect } from "vitest";
import { parseSkillMd } from "@/lib/skills/parser";

const HEADER = (deps: string): string => `---
name: test-skill
description: A test skill that exists only to exercise the dependencies-python parser path.
${deps}
---

body content
`;

describe("parseSkillMd: dependencies-python", () => {
  it("returns undefined when the key is absent", () => {
    const { frontmatter } = parseSkillMd(HEADER("version: 1.0.0"));
    expect(frontmatter.dependenciesPython).toBeUndefined();
  });

  it("parses an inline array of bare specs", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('dependencies-python: ["scipy", "scikit-learn"]'),
    );
    expect(frontmatter.dependenciesPython).toEqual(["scipy", "scikit-learn"]);
  });

  it("preserves pip-style version specifiers verbatim", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('dependencies-python: ["scikit-learn>=1.3", "torch==2.1.0"]'),
    );
    expect(frontmatter.dependenciesPython).toEqual([
      "scikit-learn>=1.3",
      "torch==2.1.0",
    ]);
  });

  it("yields an empty array for an explicit empty list", () => {
    const { frontmatter } = parseSkillMd(HEADER("dependencies-python: []"));
    expect(frontmatter.dependenciesPython).toEqual([]);
  });

  it("normalises a single bare value into a one-element array", () => {
    // Author wrote `dependencies-python: requests` without brackets.
    // The parser's parseValue returns a string in that case; we wrap.
    const { frontmatter } = parseSkillMd(HEADER("dependencies-python: requests"));
    expect(frontmatter.dependenciesPython).toEqual(["requests"]);
  });

  it("does not leak the raw key into extras", () => {
    const { frontmatter } = parseSkillMd(
      HEADER('dependencies-python: ["scipy"]'),
    );
    expect(frontmatter.extras).not.toHaveProperty("dependencies-python");
  });
});
