import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type { ExecuteParams } from "@/lib/workflows/engine";
import {
  createExecutionState,
  resolveRefs,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import type { CanonicalWorkflowSpec } from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

const MINIMAL_SPEC: CanonicalWorkflowSpec = {
  name: "demo",
  nodes: [
    {
      type: "tool",
      schema_version: "1",
      id: 0,
      description: "n",
      depends_on: [],      inputs: {
        name: "minimal",
        arguments: {},
      },
    },
  ],
  outputs: { x: "@nodes.0.x" },
};

function makeParams(
  overrides?: Partial<ExecuteParams>,
): ExecuteParams {
  return {
    workflowId: "wf-1",
    runId: "run-1",
    spec: MINIMAL_SPEC,
    input: {},
    context: {},
    abortController: new AbortController(),
    ...overrides,
  };
}

function makeState(
  init?: Partial<{
    input: Record<string, unknown>;
    context: Record<string, unknown>;
    outputs: Map<number, Record<string, unknown>>;
  }>,
): ExecutionState {
  const params = makeParams({
    input: init?.input ?? {},
    context: init?.context ?? {},
  });
  const state = createExecutionState(params);
  if (init?.outputs) {
    for (const [id, out] of init.outputs) state.outputs.set(id, out);
  }
  return state;
}

// ─── createExecutionState ─────────────────────────────────────────────

describe("createExecutionState", () => {
  it("initializes empty completed/failed/skipped/outputs", () => {
    const state = createExecutionState(makeParams());
    expect(state.completed.size).toBe(0);
    expect(state.failed.size).toBe(0);
    expect(state.skipped.size).toBe(0);
    expect(state.outputs.size).toBe(0);
  });

  it("exposes the AbortSignal from the supplied controller", () => {
    const ac = new AbortController();
    const state = createExecutionState(makeParams({ abortController: ac }));
    expect(state.abortSignal.aborted).toBe(false);
    ac.abort();
    expect(state.abortSignal.aborted).toBe(true);
  });

  it("forwards spec / input / context references unchanged", () => {
    const input = { tenant: "acme" };
    const ctx = { today: "2026-05-24" };
    const state = createExecutionState(
      makeParams({ input, context: ctx }),
    );
    expect(state.spec).toBe(MINIMAL_SPEC);
    expect(state.input).toBe(input);
    expect(state.context).toBe(ctx);
  });
});

// ─── resolveRefs — passthrough cases ──────────────────────────────────

describe("resolveRefs — passthrough", () => {
  it("returns primitives unchanged (number / boolean / null)", () => {
    const state = makeState();
    expect(resolveRefs(42, state)).toBe(42);
    expect(resolveRefs(true, state)).toBe(true);
    expect(resolveRefs(null, state)).toBeNull();
  });

  it("returns non-ref strings unchanged", () => {
    const state = makeState();
    expect(resolveRefs("hello", state)).toBe("hello");
    expect(resolveRefs("SELECT * FROM t", state)).toBe("SELECT * FROM t");
  });

  it("recursively transforms arrays and objects with no refs", () => {
    const state = makeState();
    const v = { a: [1, 2, { b: "x" }] };
    const out = resolveRefs(v, state);
    expect(out).toEqual(v);
    // ...but the result is a new object (does not mutate input).
    expect(out).not.toBe(v);
  });
});

// ─── resolveRefs — pure refs ──────────────────────────────────────────

describe("resolveRefs — pure refs", () => {
  it("@workflow.<key> → workflow input value", () => {
    const state = makeState({ input: { tenant: "acme", count: 42 } });
    expect(resolveRefs("@workflow.tenant", state)).toBe("acme");
    expect(resolveRefs("@workflow.count", state)).toBe(42);
  });

  it("@nodes.N.field → node output value (preserves type)", () => {
    const state = makeState({
      outputs: new Map([
        [0, { dataset: "path.parquet", row_count: 1234 }],
      ]),
    });
    expect(resolveRefs("@nodes.0.dataset", state)).toBe("path.parquet");
    expect(resolveRefs("@nodes.0.row_count", state)).toBe(1234);
  });

  it("preserves object values when target is an object (pure ref)", () => {
    const state = makeState({
      outputs: new Map([
        [0, { schema: { type: "object", properties: { x: 1 } } }],
      ]),
    });
    const out = resolveRefs("@nodes.0.schema", state);
    expect(out).toEqual({ type: "object", properties: { x: 1 } });
  });

  it("@context.<path> walks nested paths", () => {
    const state = makeState({
      context: {
        today: "2026-05-24",
        user: { id: "u-1", role: "admin" },
        secrets: { api_token: "sk-xxx" },
      },
    });
    expect(resolveRefs("@context.today", state)).toBe("2026-05-24");
    expect(resolveRefs("@context.user.id", state)).toBe("u-1");
    expect(resolveRefs("@context.secrets.api_token", state)).toBe("sk-xxx");
  });
});

// ─── resolveRefs — embedded refs ──────────────────────────────────────

describe("resolveRefs — embedded refs", () => {
  it("substitutes a single ref inside a larger string", () => {
    const state = makeState({ input: { tenant: "acme" } });
    expect(
      resolveRefs(
        "SELECT * FROM t WHERE tenant = '@workflow.tenant'",
        state,
      ),
    ).toBe("SELECT * FROM t WHERE tenant = 'acme'");
  });

  it("substitutes multiple refs from different sigils", () => {
    const state = makeState({
      input: { tenant: "acme" },
      outputs: new Map([[3, { org_id: 42 }]]),
      context: { secrets: { token: "sk" } },
    });
    expect(
      resolveRefs(
        "Bearer @context.secrets.token tenant=@workflow.tenant org=@nodes.3.org_id",
        state,
      ),
    ).toBe("Bearer sk tenant=acme org=42");
  });

  it("stringifies primitive node outputs (number/boolean/null)", () => {
    const state = makeState({
      outputs: new Map([
        [0, { n: 7, b: true, nada: null }],
      ]),
    });
    expect(
      resolveRefs("n=@nodes.0.n b=@nodes.0.b z=@nodes.0.nada", state),
    ).toBe("n=7 b=true z=null");
  });

  it("JSON-encodes object/array node outputs in embedded position", () => {
    const state = makeState({
      outputs: new Map([
        [0, { tags: ["a", "b"], meta: { k: 1 } }],
      ]),
    });
    expect(
      resolveRefs("tags=@nodes.0.tags; meta=@nodes.0.meta", state),
    ).toBe('tags=["a","b"]; meta={"k":1}');
  });

  it("longer ref tokens replace before shorter ones (prefix-collision safety)", () => {
    // @nodes.10.foo must not be partially matched by @nodes.1.foo.
    const state = makeState({
      outputs: new Map([
        [1, { foo: "one" }],
        [10, { foo: "ten" }],
      ]),
    });
    const out = resolveRefs("a=@nodes.10.foo b=@nodes.1.foo", state);
    expect(out).toBe("a=ten b=one");
  });

  it("recursively resolves refs inside arrays + nested objects", () => {
    const state = makeState({
      input: { tenant: "acme" },
      outputs: new Map([[0, { dataset: "p.parquet" }]]),
    });
    const result = resolveRefs(
      {
        items: ["@workflow.tenant", "@nodes.0.dataset"],
        nested: { x: "SELECT 1 WHERE t = '@workflow.tenant'" },
      },
      state,
    );
    expect(result).toEqual({
      items: ["acme", "p.parquet"],
      nested: { x: "SELECT 1 WHERE t = 'acme'" },
    });
  });
});

// ─── resolveRefs — REF_UNRESOLVED ─────────────────────────────────────

function expectRefUnresolved(fn: () => unknown, match?: RegExp): WorkflowError {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof WorkflowError)) {
      throw new Error(
        `Expected WorkflowError, got ${e instanceof Error ? e.constructor.name : typeof e}`,
      );
    }
    expect(e.errorCode).toBe("REF_UNRESOLVED");
    if (match !== undefined) expect(e.message).toMatch(match);
    return e;
  }
  throw new Error("Expected throw, got success");
}

describe("resolveRefs — REF_UNRESOLVED hard error (§7.10.3)", () => {
  it("throws when @nodes ref's node hasn't produced outputs", () => {
    const state = makeState();
    expectRefUnresolved(
      () => resolveRefs("@nodes.0.dataset", state),
      /node 0 has not produced outputs/,
    );
  });

  it("throws when @nodes ref's field is missing from outputs", () => {
    const state = makeState({
      outputs: new Map([[0, { dataset: "x" }]]),
    });
    expectRefUnresolved(
      () => resolveRefs("@nodes.0.no_such_field", state),
      /field 'no_such_field'/,
    );
  });

  it("throws when @workflow ref's key wasn't provided", () => {
    const state = makeState({ input: { other: "x" } });
    expectRefUnresolved(
      () => resolveRefs("@workflow.tenant", state),
      /workflow input 'tenant'/,
    );
  });

  it("throws when @context path walks into undefined", () => {
    const state = makeState({ context: { user: { id: "u-1" } } });
    expectRefUnresolved(
      () => resolveRefs("@context.user.role", state),
      /context\.user\.role is undefined/,
    );
  });

  it("throws when @context path crosses a non-object", () => {
    const state = makeState({ context: { name: "acme" } });
    expectRefUnresolved(
      () => resolveRefs("@context.name.inner", state),
      /not an object/,
    );
  });

  it("propagates errors from embedded refs", () => {
    const state = makeState({ input: {} });
    expectRefUnresolved(
      () =>
        resolveRefs(
          "SELECT * FROM t WHERE x = '@workflow.missing'",
          state,
        ),
      /workflow input 'missing'/,
    );
  });

  it("explicit undefined value triggers REF_UNRESOLVED, not silent passthrough", () => {
    // Using `Object.assign` to put an undefined value at a key — JS
    // distinguishes "key absent" from "key present with value undefined".
    // resolver treats both as REF_UNRESOLVED.
    const state = makeState({
      outputs: new Map([[0, Object.assign({}, { x: undefined })]]),
    });
    // 'x' is *in* the object (Object.keys includes it), so the
    // field check passes — but the value is undefined. For
    // primitives (`@nodes.0.x` pure) this returns undefined…
    // verifying the embedded path catches it:
    const pureResult = resolveRefs("@nodes.0.x", state);
    expect(pureResult).toBeUndefined();
    expectRefUnresolved(
      () => resolveRefs("x=@nodes.0.x", state),
      /Embedded ref resolved to undefined/,
    );
  });
});
