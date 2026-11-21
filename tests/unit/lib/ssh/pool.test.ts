import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const createdInstances: Array<{
  connected: boolean;
  connection: EventEmitter;
  connect: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  isConnected: () => boolean;
}> = [];

vi.mock("node-ssh", () => ({
  NodeSSH: class {
    connected = false;
    connection = new EventEmitter();
    connect = vi.fn(async () => {
      this.connected = true;
      return this;
    });
    dispose = vi.fn(() => {
      this.connected = false;
    });
    isConnected = () => this.connected;
    constructor() {
      createdInstances.push(this);
    }
  },
}));

const {
  acquireSshConnection,
  computeSshConfigDigest,
  evictSshConnection,
  clearSshPool,
} = await import("@/lib/ssh/pool.server");

beforeEach(() => {
  createdInstances.length = 0;
  clearSshPool();
  vi.useFakeTimers();
});

afterEach(() => {
  clearSshPool();
  vi.useRealTimers();
});

describe("ssh connection pool", () => {
  const auth = { kind: "password" as const, username: "u", password: "p" };

  it("reuses an existing healthy connection across sequential leases", async () => {
    const digest = computeSshConfigDigest("10.0.0.1", 22, "SHA256:abc", auth);

    const lease1 = await acquireSshConnection({
      serverId: "srv-1",
      configDigest: digest,
      connectConfig: { host: "10.0.0.1", port: 22, username: "u", password: "p" },
      idleTimeoutMs: 60_000,
    });
    lease1.release();

    const lease2 = await acquireSshConnection({
      serverId: "srv-1",
      configDigest: digest,
      connectConfig: { host: "10.0.0.1", port: 22, username: "u", password: "p" },
      idleTimeoutMs: 60_000,
    });
    lease2.release();

    expect(createdInstances).toHaveLength(1);
    expect(createdInstances[0].connect).toHaveBeenCalledTimes(1);
    expect(lease1.ssh).toBe(lease2.ssh);
  });

  it("coalesces concurrent connects for the same serverId and configDigest", async () => {
    const digest = computeSshConfigDigest("10.0.0.1", 22, "SHA256:abc", auth);
    const cfg = { host: "10.0.0.1", port: 22, username: "u", password: "p" };

    const [l1, l2] = await Promise.all([
      acquireSshConnection({
        serverId: "srv-1",
        configDigest: digest,
        connectConfig: cfg,
        idleTimeoutMs: 60_000,
      }),
      acquireSshConnection({
        serverId: "srv-1",
        configDigest: digest,
        connectConfig: cfg,
        idleTimeoutMs: 60_000,
      }),
    ]);

    expect(createdInstances).toHaveLength(1);
    expect(l1.ssh).toBe(l2.ssh);
    expect(l1.isShared()).toBe(true);
    l1.release();
    expect(l2.isShared()).toBe(false);
    l2.release();
  });

  it("evicts and reconnects when configDigest changes", async () => {
    const d1 = computeSshConfigDigest("10.0.0.1", 22, "SHA256:abc", auth);
    const d2 = computeSshConfigDigest("10.0.0.1", 22, "SHA256:abc", {
      kind: "password",
      username: "u",
      password: "new-password",
    });

    const l1 = await acquireSshConnection({
      serverId: "srv-1",
      configDigest: d1,
      connectConfig: { host: "10.0.0.1", port: 22, username: "u", password: "p" },
      idleTimeoutMs: 60_000,
    });
    l1.release();

    const l2 = await acquireSshConnection({
      serverId: "srv-1",
      configDigest: d2,
      connectConfig: { host: "10.0.0.1", port: 22, username: "u", password: "new-password" },
      idleTimeoutMs: 60_000,
    });
    l2.release();

    expect(createdInstances).toHaveLength(2);
    expect(createdInstances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("evicts on idle timeout and on evictSshConnection", async () => {
    const digest = computeSshConfigDigest("10.0.0.1", 22, "SHA256:abc", auth);
    const cfg = { host: "10.0.0.1", port: 22, username: "u", password: "p" };

    const l1 = await acquireSshConnection({
      serverId: "srv-1",
      configDigest: digest,
      connectConfig: cfg,
      idleTimeoutMs: 5_000,
    });
    l1.release();

    vi.advanceTimersByTime(5_000);
    expect(createdInstances[0].dispose).toHaveBeenCalledTimes(1);

    const l2 = await acquireSshConnection({
      serverId: "srv-1",
      configDigest: digest,
      connectConfig: cfg,
      idleTimeoutMs: 5_000,
    });
    l2.release();
    evictSshConnection("srv-1");
    expect(createdInstances[1].dispose).toHaveBeenCalledTimes(1);
  });

  it("evicts dead connections when socket emits close", async () => {
    const digest = computeSshConfigDigest("10.0.0.1", 22, "SHA256:abc", auth);
    const cfg = { host: "10.0.0.1", port: 22, username: "u", password: "p" };

    const l1 = await acquireSshConnection({
      serverId: "srv-1",
      configDigest: digest,
      connectConfig: cfg,
      idleTimeoutMs: 60_000,
    });
    l1.release();

    createdInstances[0].connection.emit("close");

    const l2 = await acquireSshConnection({
      serverId: "srv-1",
      configDigest: digest,
      connectConfig: cfg,
      idleTimeoutMs: 60_000,
    });
    l2.release();

    expect(createdInstances).toHaveLength(2);
  });

  it("does not register a connection evicted while connect is in-flight", async () => {
    const digest = computeSshConfigDigest("10.0.0.1", 22, "SHA256:abc", auth);
    const cfg = { host: "10.0.0.1", port: 22, username: "u", password: "p" };

    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((r) => {
      resolveConnect = r;
    });

    const firstAcquire = acquireSshConnection({
      serverId: "srv-race",
      configDigest: digest,
      connectConfig: cfg,
      idleTimeoutMs: 60_000,
    });
    // Replace the first instance's connect with our deferred promise.
    const inst0 = createdInstances[0];
    inst0.connect.mockImplementationOnce(async () => {
      await pendingConnect;
      inst0.connected = true;
      return inst0;
    });

    // Trigger eviction while connect is still in-flight.
    evictSshConnection("srv-race");
    resolveConnect();

    const lease1 = await firstAcquire;
    lease1.release();
    expect(inst0.dispose).toHaveBeenCalledTimes(1);

    // Next acquire must open a fresh connection rather than reusing inst0.
    const lease2 = await acquireSshConnection({
      serverId: "srv-race",
      configDigest: digest,
      connectConfig: cfg,
      idleTimeoutMs: 60_000,
    });
    lease2.release();
    expect(createdInstances).toHaveLength(2);
  });
});
