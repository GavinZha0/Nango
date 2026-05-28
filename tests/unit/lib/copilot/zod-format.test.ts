import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatZodIssues } from "@/lib/copilot/zod-format";

// `formatZodIssues` is the only pure unit in the frontend-tool-helpers
// surface; the hooks themselves are exercised via Playwright e2e since
// they depend on React context (project convention: no React hook
// unit tests, use Playwright for tool-call UI coverage).

describe("formatZodIssues", () => {
  it("joins issues into a single line with path: message format", () => {
    const schema = z.object({
      question: z.string(),
      options: z.array(z.string()).min(2),
    });
    const result = schema.safeParse({ question: 1, options: ["only-one"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodIssues(result.error);
      // Both issues present, joined with " | ".
      expect(formatted).toContain("question");
      expect(formatted).toContain("options");
      expect(formatted).toContain(" | ");
    }
  });

  it("uses '(root)' for top-level issues with empty path", () => {
    const schema = z.string();
    const result = schema.safeParse(123);
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodIssues(result.error);
      expect(formatted.startsWith("(root):")).toBe(true);
    }
  });

  it("joins nested paths with dots", () => {
    const schema = z.object({
      filter: z.object({
        date: z.object({
          from: z.string(),
        }),
      }),
    });
    const result = schema.safeParse({ filter: { date: { from: 42 } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodIssues(result.error);
      expect(formatted).toContain("filter.date.from");
    }
  });

  it("truncates at 500 chars to keep messages LLM-digestible", () => {
    // Build a deep schema that produces ~80 issues, each ~50 chars,
    // well above the 500-char cap.
    const fields = Array.from({ length: 80 }, (_, i) => [`f${i}`, z.string()] as const);
    const schema = z.object(Object.fromEntries(fields));
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodIssues(result.error);
      expect(formatted.length).toBeLessThanOrEqual(500);
      expect(formatted.endsWith("...")).toBe(true);
    }
  });
});
