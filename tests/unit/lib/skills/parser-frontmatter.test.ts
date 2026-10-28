import { describe, it, expect } from "vitest";
import { parseSkillMd, SkillParseError } from "@/lib/skills/parser";

const DOC = (fm: string): string => `---\n${fm}\n---\n\nbody content\n`;

const VERCEL_RN = DOC(`name: vercel-react-native-skills
description:
  React Native and Expo best practices for building performant mobile apps. Use
  when building React Native components, optimizing list performance,
  implementing animations, or working with native modules. Triggers on tasks
  involving React Native, Expo, mobile performance, or native platform APIs.
license: MIT
metadata:
  author: vercel
  version: '1.0.0'`);

describe("parseSkillMd: multi-line scalar values", () => {
  it("folds an indented plain multi-line description into one string", () => {
    const { frontmatter } = parseSkillMd(VERCEL_RN);
    expect(frontmatter.description).toBe(
      "React Native and Expo best practices for building performant mobile apps. Use " +
        "when building React Native components, optimizing list performance, " +
        "implementing animations, or working with native modules. Triggers on tasks " +
        "involving React Native, Expo, mobile performance, or native platform APIs.",
    );
    expect(frontmatter.name).toBe("vercel-react-native-skills");
  });

  it("keeps a folded block scalar and strips its trailing break", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: folded
description: >-
  One long sentence that keeps going
  and finishes here.`),
    );
    expect(frontmatter.description).toBe(
      "One long sentence that keeps going and finishes here.",
    );
  });

  it("keeps line breaks in a literal block scalar", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: literal
description: |-
  line one
  line two`),
    );
    expect(frontmatter.description).toBe("line one\nline two");
  });

  it("treats a blank line inside a folded value as a break", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: paragraphs
description: |-
  first

  second`),
    );
    expect(frontmatter.description).toBe("first\n\nsecond");
  });

  it("reads CRLF frontmatter", () => {
    const text = DOC(`name: crlf
description:
  Split across two lines
  on purpose for this test`).replace(/\n/g, "\r\n");
    const { frontmatter } = parseSkillMd(text);
    expect(frontmatter.description).toBe("Split across two lines on purpose for this test");
  });

  it("still accepts a single-line description unchanged", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: single
description: A short but sufficient description.`),
    );
    expect(frontmatter.description).toBe("A short but sufficient description.");
  });

  it("folds a value whose continuation contains a colon", () => {
    // Only an all-mapping block is a nested mapping; mixed content stays prose,
    // the same way YAML resolves it by forbidding ": " in a plain scalar.
    const { frontmatter } = parseSkillMd(
      DOC(`name: colon
description:
  Triggers on tasks: mobile work
  and anything else listed.`),
    );
    expect(frontmatter.description).toBe(
      "Triggers on tasks: mobile work and anything else listed.",
    );
  });
});

describe("parseSkillMd: nested mappings and sequences", () => {
  it("keeps a nested mapping under its parent key without shadowing fields", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: nested
description: Nothing nested here may become a top-level field.
metadata:
  author: vercel
  name: shadow-me
  description: shadow-me-too`),
    );
    expect(frontmatter.name).toBe("nested");
    expect(frontmatter.description).toBe(
      "Nothing nested here may become a top-level field.",
    );
    expect(frontmatter.version).toBe("1.0.0");
    expect(frontmatter.extras).toEqual({
      metadata: { author: "vercel", name: "shadow-me", description: "shadow-me-too" },
    });
  });

  it("leaves the verbatim metadata block of a real pack in extras", () => {
    const { frontmatter } = parseSkillMd(VERCEL_RN);
    expect(frontmatter.extras).toEqual({
      license: "MIT",
      metadata: { author: "vercel", version: "1.0.0" },
    });
  });

  it("uses the top-level version when both spellings are present", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: two-versions
description: Nested metadata must not win here.
metadata:
  version: 9.9.9
version: 2.0.0`),
    );
    expect(frontmatter.version).toBe("2.0.0");
  });

  it("reads a block sequence for a non-declaration key", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: tagged
description: A skill with tags listed below.
allowed-tools:
  - read_file
  - write_file
tags:
  - mobile
  - expo`),
    );
    expect(frontmatter.allowedTools).toEqual(["read_file", "write_file"]);
    expect(frontmatter.extras.tags).toEqual(["mobile", "expo"]);
  });

  it("stops a block at the next left-margin key", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: bordered
description:
  folded text continues
license: MIT
version: 3.0.0`),
    );
    expect(frontmatter.description).toBe("folded text continues");
    expect(frontmatter.version).toBe("3.0.0");
    expect(frontmatter.extras.license).toBe("MIT");
  });

  it("reads an empty value when nothing is indented under the key", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: empty
description: A key with an empty value below.
notes:`),
    );
    expect(frontmatter.extras.notes).toBe("");
  });
});

describe("parseSkillMd: error locators", () => {
  it("names SKILL.md and the line for a value-less unparsable line", () => {
    expect(() =>
      parseSkillMd(
        DOC(`name: broken
description: Valid first line.
this line has no colon`),
      ),
    ).toThrowError(/SKILL\.md line 4: invalid frontmatter line \(expected "key: value"\): this line has no colon/);
  });

  it("names the line for unexpected left-margin-less indentation", () => {
    expect(() =>
      parseSkillMd(
        DOC(`name: indented
description: A description that is fine.
- stray sequence item`),
      ),
    ).toThrowError(/SKILL\.md line 4/);
  });

  it("locates a description that exceeds the cap", () => {
    const long = "x".repeat(1025);
    expect(() =>
      parseSkillMd(DOC(`name: too_long
description: ${long}`)),
    ).toThrowError(/SKILL\.md line 3: frontmatter `description` exceeds 1024 characters \(got 1025\)/);
  });

  it("locates an empty description", () => {
    expect(() =>
      parseSkillMd(DOC(`name: blank
description:`)),
    ).toThrowError(/SKILL\.md line 3: frontmatter `description` must not be empty/);
  });

  it("locates a missing required field", () => {
    expect(() => parseSkillMd(DOC("name: no_description"))).toThrowError(
      /SKILL\.md: frontmatter `description` is required/,
    );
    expect(() => parseSkillMd(DOC("description: A name is missing from this."))).toThrowError(
      /SKILL\.md: frontmatter `name` is required/,
    );
  });

  it("locates an invalid name slug", () => {
    expect(() =>
      parseSkillMd(DOC(`name: Bad Name
description: The name above is not a slug.`)),
    ).toThrowError(/SKILL\.md line 2: frontmatter `name` must be a kebab-case slug/);
  });

  it("reports a scalar field given a nested block instead of claiming it is missing", () => {
    expect(() =>
      parseSkillMd(
        DOC(`name: nested-name
description: The name key is a mapping here.
name:
  real: value`),
      ),
    ).toThrowError(SkillParseError);
  });
});

describe("parseSkillMd: declaration keys stay single-line", () => {
  it("rejects a folded scripts-on-ssh with an actionable reason", () => {
    expect(() =>
      parseSkillMd(
        DOC(`name: folded_decl
description: The declaration below is folded.
scripts-on-ssh:
  - probe.sh`),
      ),
    ).toThrowError(/SKILL\.md line 4: `scripts-on-ssh` must be one line/);
  });

  it("rejects a folded scripts-on-db", () => {
    expect(() =>
      parseSkillMd(
        DOC(`name: folded_db
description: The declaration below is folded.
scripts-on-db:
  - reports/sales.sql`),
      ),
    ).toThrowError(/SKILL\.md line 4: `scripts-on-db` must be one line/);
  });

  it("still accepts the inline declaration forms", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: inline_decl
description: Inline declarations keep working.
scripts-on-ssh: ["probe.sh"]`),
    );
    expect(frontmatter.scriptsOnSsh).toEqual(["scripts/probe.sh"]);
  });
});

describe("parseSkillMd: Agent Skills spec compatibility", () => {
  it("adopts metadata.version when the pack has no top-level version", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: spec-pack
description: A pack authored to the published spec.
metadata:
  author: vercel
  version: "2.3.1"`),
    );
    expect(frontmatter.version).toBe("2.3.1");
  });

  it("ignores a metadata.version that is not a scalar string", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: odd-pack
description: The nested version is a list here.
metadata:
  version: ["1.0.0", "1.0.1"]`),
    );
    expect(frontmatter.version).toBe("1.0.0");
    expect(frontmatter.extras).toEqual({
      metadata: { version: ["1.0.0", "1.0.1"] },
    });
  });

  it("splits a spec-style space-separated allowed-tools string", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: spaced
description: Tools listed the way the spec spells them.
allowed-tools: read_file write_file`),
    );
    expect(frontmatter.allowedTools).toEqual(["read_file", "write_file"]);
  });

  it("accepts a description shorter than the old ten-character floor", () => {
    const { frontmatter } = parseSkillMd(
      DOC(`name: brief
description: Hi there.`),
    );
    expect(frontmatter.description).toBe("Hi there.");
  });
});
