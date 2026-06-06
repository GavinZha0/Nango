/**
 * Per-node content-addressable cache for the workflow engine.
 *
 * Cache key: `sha256(canonical({ node_semantic_fields, resolved_input }))`.
 * Cosmetic fields (id, description, depends_on, retries, timeout,
 * outputs) are stripped before hashing so they never bust the cache.
 *
 * Only successful outputs are cached. Failures are not memoized.
 *
 * See docs/workflow.md.
 */

import type { CanonicalNode } from "../spec/schema";
import { hashJson } from "../spec/hash";

// ─── Public surface ────────────────────────────────────────────────────

/**
 * Async cache interface — V1 in-process LRU implements this; future
 * Redis / SQLite backends slot in without engine-side changes.
 *
 * Values are node `outputs` objects. `get` returns `undefined` on miss.
 */
export interface WorkflowCache {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
}

/**
 * Compute the content-addressable cache key for one (node,
 * resolved-input) pair. Deterministic and stable across processes.
 *
 * `resolvedInput` is the post-ref-resolution input, NOT the literal
 * `node.input` (which still contains `@path` refs).
 */
export function computeCacheKey(
  node: CanonicalNode,
  resolvedInput: unknown,
): string {
  return hashJson({
    node: extractSemanticFields(node),
    input: resolvedInput,
  });
}

/**
 * In-process LRU cache implementation. Backed by a `Map` whose
 * iteration order doubles as access order (mutated on hit via
 * delete + re-set).
 */
export class InProcessLruCache implements WorkflowCache {
  private readonly entries = new Map<string, Record<string, unknown>>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  async get(key: string): Promise<Record<string, unknown> | undefined> {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert to move to the "most recently used" end of the Map.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Test / debug helper — current entry count. */
  get size(): number {
    return this.entries.size;
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 1000;

/** Fields whose changes do NOT affect a node's output. */
const NON_SEMANTIC_FIELDS = [
  "id",
  "description",
  "depends_on",
  "retries",
  "timeout_seconds",
  "outputs",
] as const;

function extractSemanticFields(node: CanonicalNode): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  for (const field of NON_SEMANTIC_FIELDS) delete out[field];
  return out;
}
