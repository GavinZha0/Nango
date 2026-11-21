/**
 * Lightweight in-process SSH connection pool keyed by `ssh_server.id`.
 *
 * `ssh2` multiplexes concurrent `exec` and `sftp` channels over a single
 * authenticated TCP connection, so keeping one `NodeSSH` per server id
 * eliminates repeated TCP + SSH handshakes across sequential or concurrent
 * agent tool calls. Connections are evicted on idle timeout, config/auth
 * digest change, socket close/error, or `invalidateForSshServerChange`.
 *
 * See docs/ssh.md.
 */

import "server-only";

import { createHash } from "node:crypto";
import { NodeSSH } from "node-ssh";

import type { NormalisedSshAuth } from "./credential-schema";

type ConnectConfig = Parameters<NodeSSH["connect"]>[0];

interface PoolEntry {
  serverId: string;
  configDigest: string;
  ssh: NodeSSH;
  refCount: number;
  stale: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface PooledSshLease {
  ssh: NodeSSH;
  /** Release the lease; schedules idle eviction when `refCount` hits 0. */
  release: (opts?: { destroy?: boolean }) => void;
  /** True when another concurrent caller also holds this connection. */
  isShared: () => boolean;
}

const entries = new Map<string, PoolEntry>();
const inflightConnects = new Map<
  string,
  { configDigest: string; promise: Promise<PoolEntry> }
>();
const generations = new Map<string, number>();

function bumpGeneration(serverId: string): void {
  generations.set(serverId, (generations.get(serverId) ?? 0) + 1);
}

/**
 * Compute a deterministic digest of connection target + auth material so
 * editing host/port/fingerprint/credential transparently invalidates any
 * cached connection without needing separate credential-eviction hooks.
 */
export function computeSshConfigDigest(
  host: string,
  port: number,
  knownHostFingerprint: string | null,
  auth: NormalisedSshAuth,
): string {
  const h = createHash("sha256");
  h.update(`${host}\0${port}\0${knownHostFingerprint ?? ""}\0${auth.kind}\0${auth.username}\0`);
  if (auth.kind === "password") {
    h.update(auth.password);
  } else {
    h.update(auth.privateKey);
    h.update("\0");
    h.update(auth.passphrase ?? "");
  }
  return h.digest("hex");
}

function clearIdleTimer(entry: PoolEntry): void {
  if (entry.idleTimer !== null) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function disposeEntry(entry: PoolEntry): void {
  clearIdleTimer(entry);
  if (entries.get(entry.serverId) === entry) {
    entries.delete(entry.serverId);
  }
  try {
    entry.ssh.dispose();
  } catch {
    // Best-effort cleanup.
  }
}

function scheduleIdleEviction(entry: PoolEntry, idleTimeoutMs: number): void {
  clearIdleTimer(entry);
  if (idleTimeoutMs <= 0) {
    disposeEntry(entry);
    return;
  }
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.refCount === 0) {
      disposeEntry(entry);
    }
  }, idleTimeoutMs);
  entry.idleTimer.unref?.();
}

function attachSocketEviction(entry: PoolEntry): void {
  const conn = entry.ssh.connection;
  if (!conn || typeof conn.on !== "function") return;
  const onDead = (): void => {
    entry.stale = true;
    if (entries.get(entry.serverId) === entry) {
      entries.delete(entry.serverId);
    }
    clearIdleTimer(entry);
  };
  conn.on("close", onDead);
  conn.on("error", onDead);
}

/**
 * Acquire a connected `NodeSSH` lease for `serverId`. Reuses an existing
 * healthy connection when `configDigest` matches, coalesces concurrent
 * connect attempts, and connects fresh otherwise.
 */
export async function acquireSshConnection(opts: {
  serverId: string;
  configDigest: string;
  connectConfig: ConnectConfig;
  idleTimeoutMs: number;
}): Promise<PooledSshLease> {
  const { serverId, configDigest, connectConfig, idleTimeoutMs } = opts;

  const existing = entries.get(serverId);
  if (
    existing &&
    !existing.stale &&
    existing.configDigest === configDigest &&
    existing.ssh.isConnected()
  ) {
    clearIdleTimer(existing);
    existing.refCount += 1;
    return makeLease(existing, idleTimeoutMs);
  }

  // Config changed or connection died: drop stale entry before connecting.
  if (existing) {
    existing.stale = true;
    if (existing.refCount === 0) {
      disposeEntry(existing);
    } else {
      entries.delete(serverId);
      clearIdleTimer(existing);
    }
  }

  // Coalesce concurrent connects for the same serverId + configDigest.
  let inflight = inflightConnects.get(serverId);
  if (!inflight || inflight.configDigest !== configDigest) {
    const connectGen = generations.get(serverId) ?? 0;
    const promise = (async (): Promise<PoolEntry> => {
      const ssh = new NodeSSH();
      try {
        await ssh.connect(connectConfig);
      } catch (err) {
        try {
          ssh.dispose();
        } catch {
          // ignore
        }
        throw err;
      }
      const evictedDuringConnect =
        (generations.get(serverId) ?? 0) !== connectGen;
      const entry: PoolEntry = {
        serverId,
        configDigest,
        ssh,
        refCount: 0,
        stale: evictedDuringConnect,
        idleTimer: null,
      };
      if (!evictedDuringConnect) {
        attachSocketEviction(entry);
        entries.set(serverId, entry);
      }
      return entry;
    })().finally(() => {
      if (inflightConnects.get(serverId)?.promise === promise) {
        inflightConnects.delete(serverId);
      }
    });
    inflight = { configDigest, promise };
    inflightConnects.set(serverId, inflight);
  }

  const entry = await inflight.promise;
  clearIdleTimer(entry);
  entry.refCount += 1;
  return makeLease(entry, idleTimeoutMs);
}

function makeLease(entry: PoolEntry, idleTimeoutMs: number): PooledSshLease {
  let released = false;
  return {
    ssh: entry.ssh,
    isShared: () => entry.refCount > 1,
    release: (opts?: { destroy?: boolean }) => {
      if (released) return;
      released = true;
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (opts?.destroy || entry.stale || !entry.ssh.isConnected()) {
        entry.stale = true;
        if (entry.refCount === 0) {
          disposeEntry(entry);
        } else {
          if (entries.get(entry.serverId) === entry) {
            entries.delete(entry.serverId);
          }
          clearIdleTimer(entry);
        }
        return;
      }
      if (entry.refCount === 0) {
        scheduleIdleEviction(entry, idleTimeoutMs);
      }
    },
  };
}

/**
 * Evict and dispose any pooled SSH connection for `serverId`.
 * Called by `invalidateForSshServerChange` on server edit/delete.
 */
export function evictSshConnection(serverId: string): void {
  bumpGeneration(serverId);
  inflightConnects.delete(serverId);
  const entry = entries.get(serverId);
  if (!entry) return;
  entry.stale = true;
  if (entry.refCount === 0) {
    disposeEntry(entry);
  } else {
    entries.delete(serverId);
    clearIdleTimer(entry);
  }
}

/** Test / shutdown helper: dispose all pooled connections. */
export function clearSshPool(): void {
  for (const id of inflightConnects.keys()) bumpGeneration(id);
  for (const id of entries.keys()) bumpGeneration(id);
  inflightConnects.clear();
  for (const entry of Array.from(entries.values())) {
    entry.stale = true;
    disposeEntry(entry);
  }
  entries.clear();
}
