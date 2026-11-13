import { describe, expect, it } from "vitest";

import {
  buildSuffixedSkillName,
  isValidSkillName,
  parseSkillMd,
  rewriteSkillNameInSkillMd,
} from "@/lib/skills/parser";

describe("skills/parser — name rewrite & suffix helpers", () => {
  it("keeps suffixed names within 64 chars and valid under NAME_PATTERN", () => {
    const longName = "a".repeat(64);
    const renamed = buildSuffixedSkillName(longName, "_123");
    expect(renamed.length).toBeLessThanOrEqual(64);
    expect(renamed.endsWith("_123")).toBe(true);
    expect(isValidSkillName(renamed)).toBe(true);
  });

  it("rewrites frontmatter name while preserving body and other fields", () => {
    const src = [
      "---",
      "name: my-skill",
      "description: Useful skill description.",
      "version: 1.2.3",
      "---",
      "",
      "# Body",
      "Keep this untouched.",
      "",
    ].join("\n");

    const rewritten = rewriteSkillNameInSkillMd(src, "my-skill_456");
    const parsed = parseSkillMd(rewritten);
    expect(parsed.frontmatter.name).toBe("my-skill_456");
    expect(parsed.frontmatter.description).toBe("Useful skill description.");
    expect(parsed.frontmatter.version).toBe("1.2.3");
    expect(rewritten).toContain("# Body\nKeep this untouched.");
  });
});
