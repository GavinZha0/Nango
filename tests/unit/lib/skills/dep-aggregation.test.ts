import { describe, it, expect } from "vitest";

import {
  CORE_PACKAGES,
  declaredDep,
  mergeDeps,
  packageNameOf,
  renderRequirements,
  type SkillDeps,
} from "@/lib/skills/dep-aggregation";

describe("packageNameOf", () => {
  it("returns the bare lowercase name when no spec is present", () => {
    expect(packageNameOf("scipy")).toBe("scipy");
    expect(packageNameOf("Scikit-Learn")).toBe("scikit-learn");
  });

  it("strips PEP 440 version operators", () => {
    expect(packageNameOf("scikit-learn>=1.3")).toBe("scikit-learn");
    expect(packageNameOf("torch==2.1.0")).toBe("torch");
    expect(packageNameOf("numpy~=1.26")).toBe("numpy");
    expect(packageNameOf("foo!=2.0")).toBe("foo");
    expect(packageNameOf("bar<3,>=2")).toBe("bar");
  });

  it("strips extras", () => {
    expect(packageNameOf("requests[security]")).toBe("requests");
    expect(packageNameOf("pandas[parquet,gcs]==2.1")).toBe("pandas");
  });

  it("throws on completely garbage input", () => {
    expect(() => packageNameOf("===bad")).toThrow();
  });
});

describe("mergeDeps — happy paths", () => {
  it("returns just the core packages when no skill declares deps", () => {
    const merged = mergeDeps([]);
    expect(merged.core.map((d) => d.raw)).toEqual([...CORE_PACKAGES]);
    expect(merged.bySkill.size).toBe(0);
  });

  it("groups declarations by skill and preserves order within a skill", () => {
    const perSkill: SkillDeps[] = [
      {
        skillName: "data-analyzer",
        deps: [
          declaredDep("scipy", "skills/data-analyzer/SKILL.md"),
          declaredDep("scikit-learn>=1.3", "skills/data-analyzer/SKILL.md"),
        ],
      },
    ];
    const merged = mergeDeps(perSkill);
    expect(merged.bySkill.get("data-analyzer")?.map((d) => d.raw)).toEqual([
      "scipy",
      "scikit-learn>=1.3",
    ]);
  });

  it("dedupes identical specs across two skills (no conflict)", () => {
    const perSkill: SkillDeps[] = [
      { skillName: "a", deps: [declaredDep("requests>=2.0", "skills/a/SKILL.md")] },
      { skillName: "b", deps: [declaredDep("requests>=2.0", "skills/b/SKILL.md")] },
    ];
    expect(() => mergeDeps(perSkill)).not.toThrow();
  });

  it("skips skills with empty deps arrays", () => {
    const merged = mergeDeps([{ skillName: "doc-only", deps: [] }]);
    expect(merged.bySkill.has("doc-only")).toBe(false);
  });
});

describe("mergeDeps — conflict detection", () => {
  it("throws when two skills declare different version specs for the same package", () => {
    const perSkill: SkillDeps[] = [
      { skillName: "a", deps: [declaredDep("pandas>=2.0", "skills/a/SKILL.md")] },
      { skillName: "b", deps: [declaredDep("pandas==1.5", "skills/b/SKILL.md")] },
    ];
    expect(() => mergeDeps(perSkill)).toThrow(/pandas/);
    expect(() => mergeDeps(perSkill)).toThrow(/skills\/a\/SKILL\.md/);
    expect(() => mergeDeps(perSkill)).toThrow(/skills\/b\/SKILL\.md/);
  });

  it("throws on conflict between core and a skill (skill cannot pin core)", () => {
    // Skill tries to pin pandas to a specific version different from core's bare 'pandas'.
    const perSkill: SkillDeps[] = [
      { skillName: "rebel", deps: [declaredDep("pandas==1.5.0", "skills/rebel/SKILL.md")] },
    ];
    expect(() => mergeDeps(perSkill)).toThrow(/pandas/);
  });

  it("reports MULTIPLE conflicts in a single error rather than failing fast", () => {
    const perSkill: SkillDeps[] = [
      {
        skillName: "a",
        deps: [
          declaredDep("requests>=2.0", "skills/a/SKILL.md"),
          declaredDep("scipy>=1.10", "skills/a/SKILL.md"),
        ],
      },
      {
        skillName: "b",
        deps: [
          declaredDep("requests<2.0", "skills/b/SKILL.md"),
          declaredDep("scipy<1.10", "skills/b/SKILL.md"),
        ],
      },
    ];
    let caught: Error | null = null;
    try {
      mergeDeps(perSkill);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("requests");
    expect(caught!.message).toContain("scipy");
  });
});

describe("renderRequirements", () => {
  it("emits a do-not-edit banner that mentions the regen command", () => {
    const out = renderRequirements(mergeDeps([]));
    expect(out).toContain("AUTO-GENERATED");
    expect(out).toContain("pnpm sandbox:build");
  });

  it("groups output by source skill with comment headers", () => {
    const merged = mergeDeps([
      { skillName: "alpha", deps: [declaredDep("requests", "skills/alpha/SKILL.md")] },
      { skillName: "bravo", deps: [declaredDep("polars", "skills/bravo/SKILL.md")] },
    ]);
    const out = renderRequirements(merged);
    expect(out).toContain("# === core ===");
    expect(out).toContain("# === from skills/alpha ===");
    expect(out).toContain("# === from skills/bravo ===");
  });

  it("sorts skill groups alphabetically (stable output regardless of fs order)", () => {
    const merged = mergeDeps([
      { skillName: "zeta", deps: [declaredDep("polars", "skills/zeta/SKILL.md")] },
      { skillName: "alpha", deps: [declaredDep("requests", "skills/alpha/SKILL.md")] },
    ]);
    const out = renderRequirements(merged);
    const alphaIdx = out.indexOf("from skills/alpha");
    const zetaIdx = out.indexOf("from skills/zeta");
    expect(alphaIdx).toBeGreaterThan(0);
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("ends with a trailing newline (POSIX-friendly)", () => {
    expect(renderRequirements(mergeDeps([]))).toMatch(/\n$/);
  });

  it("does not duplicate a package across skill groups when its name matches core", () => {
    // If a skill ALSO declares 'pandas' (same spec as core, no conflict), it's
    // already written under 'core' and should NOT re-appear under the skill section.
    const merged = mergeDeps([
      { skillName: "extra", deps: [declaredDep("pandas", "skills/extra/SKILL.md")] },
    ]);
    const out = renderRequirements(merged);
    const occurrences = out.split("\n").filter((l) => l.trim() === "pandas").length;
    expect(occurrences).toBe(1);
  });
});
