import { describe, expect, it } from "vitest";

import {
  InProcessLruCache,
  computeCacheKey,
} from "@/lib/workflows/engine/cache";
import type {
  CanonicalAgentNode,
  CanonicalToolNode,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

function toolNode(
  overrides?: Partial<Omit<CanonicalToolNode, "type" | "inputs">> & {
    inputs?: Partial<CanonicalToolNode["inputs"]>;
  },
): CanonicalToolNode {
  const { inputs: inputsOverride, ...rest } = overrides ?? {};
  return {
    type: "tool",
    schema_version: "1",
    id: 0,
    description: "n",
    depends_on: [],
    ...rest,
    inputs: {
      name: inputsOverride?.name ?? "extract",
      arguments: inputsOverride?.arguments ?? { sql: "select 1" },
    },
  };
}

function agentNode(
  overrides?: Partial<Omit<CanonicalAgentNode, "type" | "inputs">> & {
    inputs?: Partial<CanonicalAgentNode["inputs"]>;
  },
): CanonicalAgentNode {
  const { inputs: inputsOverride, ...rest } = overrides ?? {};
  return {
    type: "agent",
    schema_version: "1",
    id: 0,
    description: "a",
    depends_on: [],
    ...rest,
    inputs: {
      name: inputsOverride?.name ?? "Builtin / DataAnalyst",
      agent_id:
        inputsOverride?.agent_id ?? "11111111-1111-4111-8111-111111111111",
      task: inputsOverride?.task ?? "summarise",
      ...(inputsOverride?.context !== undefined && {
        context: inputsOverride.context,
      }),
    },
  };
}

// ─── computeCacheKey — semantic identity ──────────────────────────────

describe("computeCacheKey — content addressing", () => {
  it("returns the same key for identical (semantic node, input)", () => {
    const node = toolNode();
    const input = { sql: "select 1" };
    expect(computeCacheKey(node, input)).toBe(computeCacheKey(node, input));
  });

  it("is independent of node `id`", () => {
    expect(computeCacheKey(toolNode({ id: 0 }), { x: 1 })).toBe(
      computeCacheKey(toolNode({ id: 42 }), { x: 1 }),
    );
  });

  it("is independent of `description` (cosmetic field excluded)", () => {
    const a = computeCacheKey(toolNode({ description: "first" }), { x: 1 });
    const b = computeCacheKey(toolNode({ description: "EDITED" }), { x: 1 });
    expect(a).toBe(b);
  });

  it("is independent of `retries` config", () => {
    const a = computeCacheKey(toolNode(), { x: 1 });
    const b = computeCacheKey(
      toolNode({ retries: { attempts: 5, delay_seconds: 10 } }),
      { x: 1 },
    );
    expect(a).toBe(b);
  });

  it("is independent of `timeoutSeconds`", () => {
    const a = computeCacheKey(toolNode(), { x: 1 });
    const b = computeCacheKey(toolNode({ timeout_seconds: 600 }), { x: 1 });
    expect(a).toBe(b);
  });

  it("is independent of `depends_on` (scheduling only)", () => {
    const a = computeCacheKey(toolNode({ depends_on: [] }), { x: 1 });
    const b = computeCacheKey(toolNode({ depends_on: [99, 7] }), { x: 1 });
    expect(a).toBe(b);
  });
});

describe("computeCacheKey — sensitivity to semantic changes", () => {
  it("changes when tool name changes", () => {
    expect(computeCacheKey(toolNode({ inputs: { name: "extract" } }), { x: 1 })).not.toBe(
      computeCacheKey(toolNode({ inputs: { name: "transform" } }), { x: 1 }),
    );
  });

  it("changes when resolved input changes", () => {
    expect(computeCacheKey(toolNode(), { x: 1 })).not.toBe(
      computeCacheKey(toolNode(), { x: 2 }),
    );
  });

  it("changes when input_schema changes", () => {
    const baseSchema = { type: "object", required: ["sql"] };
    const editedSchema = {
      type: "object",
      required: ["sql"],
      additionalProperties: false,
    };
    expect(
      computeCacheKey(toolNode({ input_schema: baseSchema }), { sql: "x" }),
    ).not.toBe(
      computeCacheKey(toolNode({ input_schema: editedSchema }), { sql: "x" }),
    );
  });

  it("changes when output_schema changes", () => {
    expect(
      computeCacheKey(
        toolNode({
          output_schema: { type: "object", required: ["a"] },
        }),
        {},
      ),
    ).not.toBe(
      computeCacheKey(
        toolNode({
          output_schema: { type: "object", required: ["b"] },
        }),
        {},
      ),
    );
  });

  it("changes between tool and agent buckets even with same name", () => {
    const t = toolNode({ inputs: { name: "x" } });
    const a = agentNode({ inputs: { name: "x" } });
    expect(computeCacheKey(t, {})).not.toBe(computeCacheKey(a, {}));
  });

  it("changes when agentId changes (different agent UUID)", () => {
    const a = agentNode({
      inputs: { agent_id: "11111111-1111-4111-8111-111111111111" },
    });
    const b = agentNode({
      inputs: { agent_id: "22222222-2222-4222-8222-222222222222" },
    });
    expect(computeCacheKey(a, { x: 1 })).not.toBe(
      computeCacheKey(b, { x: 1 }),
    );
  });

  it("returns deterministic 64-char hex (sha256)", () => {
    const key = computeCacheKey(toolNode(), { x: 1 });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── InProcessLruCache ────────────────────────────────────────────────

describe("InProcessLruCache — basic ops", () => {
  it("get returns undefined on miss", async () => {
    const cache = new InProcessLruCache();
    expect(await cache.get("nope")).toBeUndefined();
  });

  it("set then get returns the stored value", async () => {
    const cache = new InProcessLruCache();
    await cache.set("k1", { dataset: "x" });
    expect(await cache.get("k1")).toEqual({ dataset: "x" });
  });

  it("set on existing key overwrites the value", async () => {
    const cache = new InProcessLruCache();
    await cache.set("k1", { v: 1 });
    await cache.set("k1", { v: 2 });
    expect(await cache.get("k1")).toEqual({ v: 2 });
    expect(cache.size).toBe(1);
  });
});

describe("InProcessLruCache — LRU eviction", () => {
  it("evicts the oldest entry when maxEntries is exceeded", async () => {
    const cache = new InProcessLruCache(2);
    await cache.set("a", { v: 1 });
    await cache.set("b", { v: 2 });
    await cache.set("c", { v: 3 }); // 'a' should be evicted
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toEqual({ v: 2 });
    expect(await cache.get("c")).toEqual({ v: 3 });
    expect(cache.size).toBe(2);
  });

  it("get touches an entry, moving it to MRU position", async () => {
    const cache = new InProcessLruCache(2);
    await cache.set("a", { v: 1 });
    await cache.set("b", { v: 2 });
    // Touch 'a' — now 'b' is the LRU.
    await cache.get("a");
    await cache.set("c", { v: 3 }); // 'b' should be evicted, not 'a'
    expect(await cache.get("a")).toEqual({ v: 1 });
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toEqual({ v: 3 });
  });

  it("setting an existing key moves it to MRU (re-set is a touch)", async () => {
    const cache = new InProcessLruCache(2);
    await cache.set("a", { v: 1 });
    await cache.set("b", { v: 2 });
    await cache.set("a", { v: 10 }); // re-set 'a' → 'b' is LRU
    await cache.set("c", { v: 3 }); // evicts 'b'
    expect(await cache.get("a")).toEqual({ v: 10 });
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toEqual({ v: 3 });
  });
});
