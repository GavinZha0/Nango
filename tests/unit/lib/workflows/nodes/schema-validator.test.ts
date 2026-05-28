import { describe, expect, it } from "vitest";

import {
  formatValidationErrors,
  validateAgainstSchema,
} from "@/lib/workflows/nodes/schema-validator";

// ─── validateAgainstSchema ────────────────────────────────────────────

describe("validateAgainstSchema — pass cases", () => {
  it("accepts a value that matches type + required keys", () => {
    const schema = {
      type: "object",
      properties: { sql: { type: "string" }, limit: { type: "integer" } },
      required: ["sql"],
    };
    expect(
      validateAgainstSchema(schema, { sql: "select 1", limit: 100 }),
    ).toEqual({ ok: true });
  });

  it("accepts schema with no required keys / partial input", () => {
    const schema = {
      type: "object",
      properties: { sql: { type: "string" } },
    };
    expect(validateAgainstSchema(schema, {})).toEqual({ ok: true });
  });

  it("accepts top-level non-object schemas (e.g. string root)", () => {
    expect(validateAgainstSchema({ type: "string" }, "hello")).toEqual({
      ok: true,
    });
  });

  it("accepts arrays and nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        meta: {
          type: "object",
          properties: { author: { type: "string" } },
          required: ["author"],
        },
      },
      required: ["tags", "meta"],
    };
    expect(
      validateAgainstSchema(schema, {
        tags: ["a", "b"],
        meta: { author: "alice" },
      }),
    ).toEqual({ ok: true });
  });
});

describe("validateAgainstSchema — fail cases", () => {
  it("rejects when a required key is missing", () => {
    const schema = {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    };
    const result = validateAgainstSchema(schema, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.keyword).toBe("required");
    expect(result.errors[0]!.message).toMatch(/sql/);
  });

  it("rejects when a property has the wrong type", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };
    const result = validateAgainstSchema(schema, { count: "not a number" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.errors[0]!.keyword).toBe("type");
    expect(result.errors[0]!.path).toBe("/count");
  });

  it("collects ALL errors when allErrors: true (default config)", () => {
    const schema = {
      type: "object",
      properties: {
        sql: { type: "string" },
        limit: { type: "integer" },
        offset: { type: "integer" },
      },
      required: ["sql", "limit", "offset"],
    };
    const result = validateAgainstSchema(schema, { sql: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    // Expect at least 3 errors: type mismatch on `sql`, missing
    // required `limit`, missing required `offset`.
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects top-level type mismatch", () => {
    const result = validateAgainstSchema({ type: "string" }, 42);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.errors[0]!.path).toBe("");
    expect(result.errors[0]!.keyword).toBe("type");
  });

  it("rejects nested objects with deep errors (reports correct path)", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { inner: { type: "string" } },
          required: ["inner"],
        },
      },
      required: ["outer"],
    };
    const result = validateAgainstSchema(schema, { outer: { inner: 42 } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.errors[0]!.path).toBe("/outer/inner");
    expect(result.errors[0]!.keyword).toBe("type");
  });
});

describe("validateAgainstSchema — tolerant config", () => {
  it("does NOT error on unknown keywords (strict: false)", () => {
    // Some MCP servers ship vendor extensions like `x-mcp-required`
    // that aren't in standard JSON Schema. ajv strict mode would
    // reject the schema at compile time; we disable strict.
    const schema = {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
      "x-mcp-tags": ["read-only"], // vendor extension
    };
    expect(() =>
      validateAgainstSchema(schema, { sql: "select 1" }),
    ).not.toThrow();
  });
});

// ─── formatValidationErrors ───────────────────────────────────────────

describe("formatValidationErrors", () => {
  it("returns 'no schema violations' for empty array", () => {
    expect(formatValidationErrors([])).toBe("no schema violations");
  });

  it("joins multiple errors with semicolons", () => {
    const errors = [
      { path: "/sql", keyword: "type", message: "must be string", schemaPath: "x" },
      { path: "/limit", keyword: "required", message: "must have required property 'limit'", schemaPath: "y" },
    ];
    const formatted = formatValidationErrors(errors);
    expect(formatted).toContain("/sql");
    expect(formatted).toContain("[type]");
    expect(formatted).toContain("/limit");
    expect(formatted).toContain("[required]");
    expect(formatted).toMatch(/;\s/);
  });

  it("uses '(root)' for empty path", () => {
    const errors = [
      { path: "", keyword: "type", message: "must be object", schemaPath: "#/type" },
    ];
    expect(formatValidationErrors(errors)).toMatch(/\(root\)/);
  });
});
