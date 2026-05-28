/**
 * Per-node content-addressable cache (D20 Plan C, §7.4 Level 1).
 *
 * Purpose: memoize node outputs so that
 *   - re-running a workflow whose nodes haven't changed semantically
 *     skips the actual executor (e.g. expensive SQL / agent calls);
 *   - editing one node only invalidates *that* node + downstream
 *     (upstream cache keys are unchanged → cache hit on upstream);
 *   - cosmetic edits (`description`, `retries`) NEVER bust the
 *     cache — those fields are excluded from the key.
 *
 * Cache key (content-addressable):
 *   key = sha256(canonical({ node_semantic_fields, resolved_input }))
 *
 *   where `node_semantic_fields` is the canonical node minus
 *   fields that don't affect the output:
 *     - id              (just numbering)
 *     - description     (cosmetic)
 *     - depends_on      (scheduling, not computation)
 *     - retries         (retry policy doesn't change the eventual
 *                        output of a successful node)
 *     - timeoutSeconds  (runtime concern)
 *     - outputs         (derived from output_schema)
 *
 * The same SQL query in two different workflows hits the same
 * cache entry — that's the whole point of content addressing.
 *
 * Only SUCCESSFUL outputs are cached. Failures are not memoized
 * (they could be transient).
 *
 * Invalidation: none needed. Content addressing IS the
 * invalidation — change anything semantic about a node, its key
 * changes, the old entry stays cached but unreferenced (LRU
 * eventually evicts it).
 *
 * Storage: V1 is an in-process LRU (this file). The interface is
 * async so V2 can drop in Redis / SQLite / etc. without engine-
 * side changes.
 *
 * NOT in V1 scope (deferred):
 *   - Level 2 workflow-output cache (lives in resolve-data.ts,
 *     W1.5 — also keyed by sha256(spec, inputs))
 *   - TTL (content addressing makes this unnecessary)
 *   - Cross-process / cross-restart persistence
 */

import type { CanonicalNode } from "../spec/schema";
import { hashJson } from "../spec/hash";

// ─── Public surface ────────────────────────────────────────────────────

/**
 * Async cache interface — V1 in-process LRU implements this; V2
 * Redis / SQLite would slot in without engine-side changes.
 *
 * Values are node `outputs` objects (`Record<string, unknown>`).
 * `get` returns `undefined` on miss.
 */
export interface WorkflowCache {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
}

/**
 * Compute the content-addressable cache key for one (node,
 * resolved-input) pair. Deterministic and stable across processes
 * — keys can be safely compared across runs / hosts.
 *
 * Note: `resolvedInput` is the post-ref-resolution input
 * (containing concrete values from upstream node outputs), NOT
 * the literal `node.input` (which still contains `@path` refs).
 * Resolved input captures the upstream's actual contribution.
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
 * iteration order doubles as access order (insertion order
 * initially, mutated on hit via delete + re-set). Synchronous
 * internals exposed via the async interface.
 *
 * `maxEntries` defaults to 1000 — adequate for V1's expected load
 * (handful of workflows × ~50 nodes each × a few unique input
 * permutations).
 */
export class InProcessLruCache implements WorkflowCache {
  private readonly entries = new Map<string, Record<string, unknown>>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  async get(key: string): Promise<Record<string, unknown> | undefined> {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Move to the "most recently used" end of the Map by
    // re-inserting. JavaScript Map preserves insertion order;
    // we exploit that for LRU.
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

/** Fields whose changes do NOT affect a node's output and should
 *  therefore NOT participate in the cache key. */
const NON_SEMANTIC_FIELDS = [
  "id",
  "description",
  "depends_on",
  "retries",
  "timeoutSeconds",
  "outputs",
] as const;

function extractSemanticFields(node: CanonicalNode): Record<string, unknown> {
  // Spread-and-delete keeps the implementation small while
  // preserving the discriminated-union shape (`type`, `tool` or
  // `agent` + `agentId`, `input_schema`, `output_schema`).
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  for (const field of NON_SEMANTIC_FIELDS) delete out[field];
  return out;
}
