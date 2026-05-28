import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import { canonicalJson, hashJson } from "@/lib/workflows/spec/hash";

/**
 * Assert that `fn` throws a WorkflowError with code
 * SPEC_SCHEMA_MISMATCH, optionally matching the message.
 */
function expectSchemaMismatch(fn: () => unknown, match?: RegExp): WorkflowError {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof WorkflowError)) {
      throw new Error(
        `Expected WorkflowError, got ${e instanceof Error ? e.constructor.name : typeof e}`,
      );
    }
    expect(e.errorCode).toBe("SPEC_SCHEMA_MISMATCH");
    expect(e.nodeId).toBeUndefined(); // workflow-scoped — no node context
    if (match !== undefined) expect(e.message).toMatch(match);
    return e;
  }
  throw new Error("Expected throw, got success");
}

// ─── canonicalJson — primitives ───────────────────────────────────────

describe("canonicalJson — primitives", () => {
  it("serializes null / boolean", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
  });

  it("serializes finite numbers (incl. negative zero as 0)", () => {
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(-7)).toBe("-7");
    expect(canonicalJson(3.14)).toBe("3.14");
  });

  it("serializes strings with JSON escaping", () => {
    expect(canonicalJson("")).toBe('""');
    expect(canonicalJson("hello")).toBe('"hello"');
    expect(canonicalJson('a "b" c')).toBe('"a \\"b\\" c"');
    expect(canonicalJson("line\nbreak")).toBe('"line\\nbreak"');
  });
});

// ─── canonicalJson — composites + key sorting ─────────────────────────

describe("canonicalJson — composites", () => {
  it("serializes empty array and empty object", () => {
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("preserves array order (arrays are positional)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
  });

  it("sorts object keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // Even with non-ASCII / hyphen / underscore in keys.
    expect(
      canonicalJson({ z_last: 1, a: 2, "b-c": 3 }),
    ).toBe('{"a":2,"b-c":3,"z_last":1}');
  });

  it("produces equal output for two objects with the same content, different insertion order", () => {
    const a = { foo: 1, bar: 2, baz: 3 };
    const b = { baz: 3, foo: 1, bar: 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("recurses into nested objects with stable key order at every level", () => {
    const v = {
      outer: { b: 1, a: 2 },
      list: [{ y: 1, x: 2 }],
    };
    expect(canonicalJson(v)).toBe('{"list":[{"x":2,"y":1}],"outer":{"a":2,"b":1}}');
  });

  it("escapes object keys with special chars correctly", () => {
    expect(canonicalJson({ 'a"b': 1 })).toBe('{"a\\"b":1}');
  });
});

// ─── canonicalJson — non-canonicalizable inputs ───────────────────────

describe("canonicalJson — invalid inputs throw WorkflowError(SPEC_SCHEMA_MISMATCH)", () => {
  it("throws on undefined at root", () => {
    expectSchemaMismatch(() => canonicalJson(undefined), /undefined/);
  });

  it("throws on undefined inside object", () => {
    expectSchemaMismatch(() => canonicalJson({ a: undefined }), /undefined/);
  });

  it("throws on undefined inside array", () => {
    expectSchemaMismatch(() => canonicalJson([1, undefined, 3]), /undefined/);
  });

  it("throws on NaN / Infinity / -Infinity", () => {
    expectSchemaMismatch(() => canonicalJson(Number.NaN), /non-finite/);
    expectSchemaMismatch(
      () => canonicalJson(Number.POSITIVE_INFINITY),
      /non-finite/,
    );
    expectSchemaMismatch(
      () => canonicalJson(Number.NEGATIVE_INFINITY),
      /non-finite/,
    );
  });

  it("throws on bigint / symbol / function", () => {
    expectSchemaMismatch(() => canonicalJson(BigInt(1)), /bigint/);
    expectSchemaMismatch(() => canonicalJson(Symbol("s")), /symbol/);
    expectSchemaMismatch(() => canonicalJson(() => 1), /function/);
  });

  it("throws on circular references", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expectSchemaMismatch(() => canonicalJson(cyc), /circular/);
  });

  it("throws on circular reference via array", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expectSchemaMismatch(() => canonicalJson(arr), /circular/);
  });

  it("does not throw on sibling references to the same object (shared subtree)", () => {
    // Two paths to the same object are NOT a cycle — `seen` must
    // be popped after recursion, not left as a global blocklist.
    const shared = { x: 1 };
    const v = { a: shared, b: shared };
    expect(() => canonicalJson(v)).not.toThrow();
    expect(canonicalJson(v)).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

// ─── hashJson ─────────────────────────────────────────────────────────

describe("hashJson", () => {
  it("returns a 64-character lowercase hex string", () => {
    const h = hashJson({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across calls", () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ a: 1, b: 2 }));
  });

  it("is invariant under object-key reordering", () => {
    expect(hashJson({ a: 1, b: 2, c: 3 })).toBe(
      hashJson({ c: 3, a: 1, b: 2 }),
    );
  });

  it("differs when any leaf value changes", () => {
    const a = hashJson({ x: 1 });
    const b = hashJson({ x: 2 });
    expect(a).not.toBe(b);
  });

  it("differs when an extra key is added", () => {
    const a = hashJson({ x: 1 });
    const b = hashJson({ x: 1, y: 1 });
    expect(a).not.toBe(b);
  });

  it("differs when array order changes", () => {
    const a = hashJson({ list: [1, 2, 3] });
    const b = hashJson({ list: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it("matches the direct sha256 of canonicalJson output (sanity)", () => {
    const v = { z: 1, a: [{ b: 2, c: 3 }] };
    const expected = createHash("sha256")
      .update(canonicalJson(v))
      .digest("hex");
    expect(hashJson(v)).toBe(expected);
  });

  it("propagates canonicalJson errors as WorkflowError(SPEC_SCHEMA_MISMATCH)", () => {
    expectSchemaMismatch(() => hashJson({ a: undefined }), /undefined/);
  });
});

// ─── Per-node cache key composition (consumer-side smoke test) ────────

describe("hashJson — Plan C per-node cache shape (smoke)", () => {
  it("cosmetic edits to a non-hashed field don't change the per-node hash", () => {
    // Engine cache layer is expected to STRIP `description` / `retries`
    // before feeding the node into hashJson. This test models that
    // stripping happens at the call site.
    const stripDescription = (n: Record<string, unknown>) => {
      const rest = { ...n };
      delete rest.description;
      delete rest.retries;
      return rest;
    };
    const n1 = {
      id: 0,
      tool: "fetch_data_table",
      input: { sql: "select 1" },
      description: "first description",
      retries: { attempts: 1, delaySeconds: 5 },
    };
    const n2 = {
      ...n1,
      description: "edited description",
      retries: { attempts: 3, delaySeconds: 10 },
    };
    expect(hashJson(stripDescription(n1))).toBe(
      hashJson(stripDescription(n2)),
    );
  });

  it("changing tool input changes the per-node hash", () => {
    const a = {
      id: 0,
      tool: "fetch_data_table",
      input: { sql: "select 1" },
    };
    const b = { ...a, input: { sql: "select 2" } };
    expect(hashJson(a)).not.toBe(hashJson(b));
  });
});
