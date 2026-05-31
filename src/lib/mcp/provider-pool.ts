/**
 * Process-wide MCP provider pool — reference-counted, idle-reaped.
 *
 * See docs/builtin-runtime.md.
 */

import "server-only";

import {
  createGracefulMcpProvider,
  type GracefulMcpProvider,
} from "@/lib/mcp/client-providers";

export interface McpServerConfig {
  serverId: string;
  label: string;
  type: "sse" | "http";
  url: string;
  /** Resolved auth headers (Bearer / X-API-Key / …). */
  headers?: Record<string, string>;
}

/** CONTRACT: returning `null` indicates missing/disabled server. `borrow()` rejects to avoid caching the miss. */
export type McpServerConfigLoader = (
  serverId: string,
) => Promise<McpServerConfig | null>;

export interface PoolOptions {
  loadConfig: McpServerConfigLoader;
  /** Ms an idle entry (refs=0) survives before reaper close. */
  idleTimeoutMs?: number;
  /** Reaper polling interval. Smaller = quicker eviction. */
  reaperIntervalMs?: number;
  /** Ms a server is excluded from new borrows after a discovery
   *  failure (set by {@link McpProviderPool.evictWithCooldown}). */
  failureCooldownMs?: number;
  /** Provider factory override (tests inject fakes). */
  createProvider?: (cfg: McpServerConfig) => GracefulMcpProvider;
}

interface Entry {
  serverId: string;
  provider: GracefulMcpProvider;
  refs: number;
  /** `refs` last zero timestamp; null while in use. */
  idleSince: number | null;
  /** Evicted but still referenced; deferred to `draining`. */
  detached: boolean;
}

export interface PoolSnapshot {
  entries: Array<{ serverId: string; refs: number; idleSince: number | null }>;
  creating: string[];
  draining: Array<{ serverId: string; refs: number }>;
}

import { getConfigMs } from "@/lib/config";

const DEFAULT_IDLE_TIMEOUT_S: number = 300;
const DEFAULT_REAPER_INTERVAL_S: number = 60;
/** Default cooldown after a discovery/connection failure before
 *  letting the next borrow attempt to reconnect. Prevents a stuck
 *  MCP server from being hammered with reconnect attempts on every
 *  dispatch (one failed connect = one 5 s timeout per chat turn). */
const DEFAULT_FAILURE_COOLDOWN_S: number = 30;

/**
 * Reference-counted MCP provider pool. CONTRACT: safe across concurrent
 * callers — Node's single-threaded event loop prevents preemption in
 * synchronous refcount mutation.
 */
export class McpProviderPool {
  private readonly entries: Map<string, Entry> = new Map();
  private readonly creating: Map<string, Promise<GracefulMcpProvider>> = new Map();
  private draining: Entry[] = [];
  private reaperHandle: ReturnType<typeof setInterval> | null = null;
  private shuttingDown: boolean = false;

  /** `serverId → epoch-ms` at which the cooldown window ends. While
   *  `now < value`, `borrow()` short-circuits to a failure without
   *  attempting `createProviderForServer`. Set by
   *  {@link evictWithCooldown}; checked + cleared on borrow. */
  private readonly cooldownUntil: Map<string, number> = new Map();

  private readonly loadConfig: McpServerConfigLoader;
  private readonly idleTimeoutMs: number;
  private readonly reaperIntervalMs: number;
  private readonly failureCooldownMs: number;
  private readonly createProvider: (cfg: McpServerConfig) => GracefulMcpProvider;

  constructor(opts: PoolOptions) {
    this.loadConfig = opts.loadConfig;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? getConfigMs("cache.mcp_pool.idle_timeout", DEFAULT_IDLE_TIMEOUT_S);
    this.reaperIntervalMs = opts.reaperIntervalMs ?? getConfigMs("cache.mcp_pool.reaper_interval", DEFAULT_REAPER_INTERVAL_S);
    this.failureCooldownMs = opts.failureCooldownMs ?? getConfigMs("cache.mcp_pool.failure_cooldown", DEFAULT_FAILURE_COOLDOWN_S);
    this.createProvider =
      opts.createProvider ??
      ((cfg) =>
        createGracefulMcpProvider({
          label: cfg.label,
          type: cfg.type,
          url: cfg.url,
          headers: cfg.headers,
        }));
  }

  /** Idempotent reaper start. */
  startReaper(): void {
    if (this.reaperHandle !== null) return;
    this.reaperHandle = setInterval(() => this.runReaper(), this.reaperIntervalMs);
    if (typeof (this.reaperHandle as { unref?: () => void }).unref === "function") {
      (this.reaperHandle as { unref: () => void }).unref();
    }
  }

  /**
   * Acquire a provider for `serverId`. CONTRACT: caller must pair
   * every successful borrow with exactly one `release()`.
   * @throws if shutting down or the config loader returns null.
   */
  async borrow(serverId: string): Promise<GracefulMcpProvider> {
    if (this.shuttingDown) throw new Error("McpProviderPool is shutting down");

    // Honour an active failure-cooldown window so we don't pummel a
    // stuck MCP server with reconnect attempts on every dispatch.
    // The cooldown is set by {@link evictWithCooldown} after a
    // discovery / connection failure; once it expires we let the
    // next borrow try a fresh connection.
    const cooldownEnds = this.cooldownUntil.get(serverId);
    if (cooldownEnds !== undefined) {
      if (Date.now() < cooldownEnds) {
        const remainingMs = cooldownEnds - Date.now();
        throw new Error(
          `MCP server ${serverId} is in failure cooldown for ${Math.ceil(remainingMs / 1000)}s more; skipping borrow`,
        );
      }
      // Cooldown expired — allow this borrow to attempt a fresh
      // connection. Clearing here (instead of on a timer) keeps the
      // map size bounded by serverIds we've actually touched.
      this.cooldownUntil.delete(serverId);
    }

    const existing = this.entries.get(serverId);
    if (existing && !existing.detached) {
      existing.refs += 1;
      existing.idleSince = null;
      return existing.provider;
    }

    let pending: Promise<GracefulMcpProvider> | undefined = this.creating.get(serverId);
    if (!pending) {
      pending = this.createProviderForServer(serverId);
      this.creating.set(serverId, pending);
      // Always clear the slot, success or failure — failures must be
      // retryable on the next borrow. Trailing `.catch` swallows the
      // cleanup-branch rejection only; awaiters see the original error.
      pending
        .finally(() => {
          this.creating.delete(serverId);
        })
        .catch(() => undefined);
    }

    const provider: GracefulMcpProvider = await pending;

    let entry: Entry | undefined = this.entries.get(serverId);
    if (!entry || entry.detached) {
      entry = {
        serverId,
        provider,
        refs: 0,
        idleSince: null,
        detached: false,
      };
      this.entries.set(serverId, entry);
    } else if (entry.provider !== provider) {
      // SECURITY: defensive — if somehow another path produced a
      // different provider object, close the orphan to avoid a leak.
      void provider.close();
    }
    entry.refs += 1;
    entry.idleSince = null;
    return entry.provider;
  }

  /**
   * Decrement refcount. CONTRACT: `provider` MUST be the exact object
   * returned by the matching `borrow()` — identity matching
   * disambiguates the case where `evict()` detached the original and
   * a fresh provider was installed for the same `serverId`.
   *
   * Calls without a matching borrow are silently ignored.
   */
  release(serverId: string, provider: GracefulMcpProvider): void {
    const entry: Entry | undefined = this.entries.get(serverId);
    if (entry && !entry.detached && entry.provider === provider) {
      if (entry.refs <= 0) {
        // Stale / duplicate release; don't go negative or the reaper
        // would never fire.
        return;
      }
      entry.refs -= 1;
      if (entry.refs === 0) entry.idleSince = Date.now();
      return;
    }

    // Detached entries live in `draining` until last release. Match
    // by provider identity so we decrement the exact entry borrowed.
    const idx: number = this.draining.findIndex(
      (e) => e.serverId === serverId && e.provider === provider && e.refs > 0,
    );
    if (idx === -1) return;
    const drained: Entry = this.draining[idx];
    drained.refs -= 1;
    if (drained.refs === 0) {
      this.draining.splice(idx, 1);
      void drained.provider.close().catch(() => undefined);
    }
  }

  /**
   * Evict the entry for `serverId` AND set a failure cooldown so
   * subsequent borrows reject for `failureCooldownMs` (default 30 s)
   * without re-attempting the connection. Use this when an existing
   * provider's `health` indicates a discovery / connection failure:
   * the existing provider is unusable so it must be evicted, but
   * an immediate retry on the next dispatch would just hit the same
   * 5-second timeout and burn network resources.
   *
   * After the cooldown expires the next borrow will create a fresh
   * provider and re-run discovery — a stuck server thus auto-heals
   * within `failureCooldownMs` of becoming reachable again.
   */
  async evictWithCooldown(serverId: string): Promise<void> {
    this.cooldownUntil.set(serverId, Date.now() + this.failureCooldownMs);
    await this.evict(serverId);
  }

  /**
   * Force-remove the entry for `serverId`. Closes immediately if
   * nobody is using it; otherwise detaches so current borrowers
   * continue on the existing provider object while the next
   * `borrow()` opens fresh.
   *
   * Does NOT set a cooldown — use {@link evictWithCooldown} when the
   * eviction is caused by an upstream failure that should be
   * back-pressured.
   */
  async evict(serverId: string): Promise<void> {
    // SECURITY: wait for any in-flight create to settle before
    // evicting — otherwise we'd race the borrow() that's about to
    // install a new entry from a Promise we already failed to
    // invalidate.
    const inflight: Promise<GracefulMcpProvider> | undefined = this.creating.get(serverId);
    if (inflight) {
      try {
        await inflight;
      } catch {
        /* creation failed — nothing to evict */
      }
    }

    const entry: Entry | undefined = this.entries.get(serverId);
    if (!entry) return;

    this.entries.delete(serverId);

    if (entry.refs > 0) {
      entry.detached = true;
      this.draining.push(entry);
      return;
    }

    try {
      await entry.provider.close();
    } catch {
      /* ignore close failures — the connection is gone either way */
    }
  }

  /** Idempotent shutdown — closes everything and rejects future borrows. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reaperHandle !== null) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
    const all: Entry[] = [...this.entries.values(), ...this.draining];
    this.entries.clear();
    this.draining = [];
    await Promise.allSettled(all.map((e) => e.provider.close()));
  }

  // Private

  private async createProviderForServer(serverId: string): Promise<GracefulMcpProvider> {
    const cfg: McpServerConfig | null = await this.loadConfig(serverId);
    if (!cfg) {
      throw new Error(`MCP server config not found or disabled: ${serverId}`);
    }
    return this.createProvider(cfg);
  }

  private runReaper(): void {
    if (this.shuttingDown) return;
    const now: number = Date.now();
    for (const [id, entry] of [...this.entries]) {
      if (
        entry.refs === 0 &&
        entry.idleSince !== null &&
        now - entry.idleSince >= this.idleTimeoutMs
      ) {
        this.entries.delete(id);
        void entry.provider.close();
      }
    }
  }

  // Test helpers (underscore-prefixed; not part of the contract)

  _inspect(): PoolSnapshot {
    return {
      entries: [...this.entries.values()].map((e) => ({
        serverId: e.serverId,
        refs: e.refs,
        idleSince: e.idleSince,
      })),
      creating: [...this.creating.keys()],
      draining: this.draining.map((e) => ({ serverId: e.serverId, refs: e.refs })),
    };
  }

  _runReaperNow(): void {
    this.runReaper();
  }
}
