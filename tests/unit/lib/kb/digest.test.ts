import { describe, expect, it } from "vitest";

import { derivePageDescription } from "@/lib/kb/digest";
import { MAX_DESCRIPTION_CHARS } from "@/lib/kb/limits";

const MD = "text/markdown";
const PLAIN = "text/plain";

describe("kb/digest — the description a page gets from its own body", () => {
  it("takes the first prose paragraph and joins its lines", () => {
    expect(
      derivePageDescription(
        "# Install guide\n\nRun `make up` first,\nthen open the dashboard.\n",
        MD,
      ),
    ).toBe("Run `make up` first, then open the dashboard.");
  });

  it("skips YAML front matter, which is metadata, not prose", () => {
    expect(
      derivePageDescription(
        "---\ntitle: Weekly\n tags: [ops]\n---\n\nDeployed v3 on Tuesday.\n",
        MD,
      ),
    ).toBe("Deployed v3 on Tuesday.");
  });

  it("skips a heading-only opening and horizontal rules", () => {
    expect(
      derivePageDescription("### Chapter 2\n\n---\n\nWhat changed here.\n", MD),
    ).toBe("What changed here.");
  });

  it("treats a blank line as the end of the paragraph", () => {
    expect(derivePageDescription("First line.\n\nSecond paragraph.\n", MD)).toBe(
      "First line.",
    );
  });

  it("handles CRLF and a file with no paragraph at all", () => {
    expect(derivePageDescription("# Title\r\n\r\nBody.\r\n", MD)).toBe("Body.");
    expect(derivePageDescription("# Only a title\n", MD)).toBeNull();
    expect(derivePageDescription("\n\n   \n", MD)).toBeNull();
    expect(derivePageDescription("", MD)).toBeNull();
    // An unterminated fence reads as a horizontal rule, so the prose below it
    // is still the page's first paragraph.
    expect(derivePageDescription("---\nno closing fence\n", MD)).toBe(
      "no closing fence",
    );
  });

  it("describes plain text the same way, including non-Latin prose", () => {
    expect(derivePageDescription("构建 说明：先执行 make up。\n", PLAIN)).toBe(
      "构建 说明：先执行 make up。",
    );
  });

  it("leaves data files with no sentence to describe", () => {
    expect(derivePageDescription("id,name\n1,x\n", "text/csv")).toBeNull();
    expect(derivePageDescription('{"a": 1}', "application/json")).toBeNull();
    expect(derivePageDescription("- a\n- b\n", "text/yaml")).toBeNull();
  });

  it("cuts a long paragraph on a word boundary inside the description cap", () => {
    const words: string = Array.from(
      { length: 200 },
      (_, index) => `word${index}`,
    ).join(" ");
    const out: string | null = derivePageDescription(`${words}\n`, MD);

    expect(out).not.toBeNull();
    const kept: string = (out as string).slice(0, -1);
    expect((out as string).endsWith("…")).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    // An exact prefix of the paragraph that stops at a whole word: the line an
    // agent reads is the author's, just shorter.
    expect(words.startsWith(kept)).toBe(true);
    expect(kept.endsWith(" ")).toBe(false);
    expect(words[kept.length]).toBe(" ");
  });

  it("keeps a paragraph that exactly fits the cap untouched", () => {
    const exact: string = "x".repeat(MAX_DESCRIPTION_CHARS);
    expect(derivePageDescription(`${exact}\n`, MD)).toBe(exact);
  });
});
