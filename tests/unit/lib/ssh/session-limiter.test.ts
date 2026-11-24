import { describe, it, expect } from "vitest";
import {
  acquireSshSessionSlot,
  __sshSessionSlotStats,
} from "@/lib/ssh/session-limiter.server";

describe("acquireSshSessionSlot", () => {
  it("grants slots immediately up to maxSessions and tracks active count", async () => {
    const s1 = acquireSshSessionSlot("srv-a", 2);
    const s2 = acquireSshSessionSlot("srv-a", 2);

    const r1 = await s1.ready;
    const r2 = await s2.ready;
    expect(__sshSessionSlotStats("srv-a")).toEqual({ active: 2, waiters: 0 });

    r1();
    expect(__sshSessionSlotStats("srv-a")).toEqual({ active: 1, waiters: 0 });
    r2();
    expect(__sshSessionSlotStats("srv-a")).toEqual({ active: 0, waiters: 0 });
  });

  it("queues excess callers in FIFO order and wakes them on release", async () => {
    const order: string[] = [];
    const r1 = await acquireSshSessionSlot("srv-fifo", 1).ready;

    const p2 = acquireSshSessionSlot("srv-fifo", 1).ready.then((rel) => {
      order.push("second");
      return rel;
    });
    const p3 = acquireSshSessionSlot("srv-fifo", 1).ready.then((rel) => {
      order.push("third");
      return rel;
    });

    expect(__sshSessionSlotStats("srv-fifo")).toEqual({ active: 1, waiters: 2 });

    r1();
    const r2 = await p2;
    expect(order).toEqual(["second"]);
    expect(__sshSessionSlotStats("srv-fifo")).toEqual({ active: 1, waiters: 1 });

    r2();
    const r3 = await p3;
    expect(order).toEqual(["second", "third"]);
    expect(__sshSessionSlotStats("srv-fifo")).toEqual({ active: 1, waiters: 0 });

    r3();
    expect(__sshSessionSlotStats("srv-fifo")).toEqual({ active: 0, waiters: 0 });
  });

  it("isolates limits per serverId", async () => {
    const rA = await acquireSshSessionSlot("srv-iso-a", 1).ready;
    const rB = await acquireSshSessionSlot("srv-iso-b", 1).ready;

    expect(__sshSessionSlotStats("srv-iso-a")).toEqual({ active: 1, waiters: 0 });
    expect(__sshSessionSlotStats("srv-iso-b")).toEqual({ active: 1, waiters: 0 });

    rA();
    rB();
  });

  it("removes a queued caller on cancel() without disturbing active slots", async () => {
    const r1 = await acquireSshSessionSlot("srv-cancel-wait", 1).ready;
    const s2 = acquireSshSessionSlot("srv-cancel-wait", 1);
    const s3 = acquireSshSessionSlot("srv-cancel-wait", 1);

    expect(__sshSessionSlotStats("srv-cancel-wait")).toEqual({ active: 1, waiters: 2 });

    s2.cancel();
    expect(__sshSessionSlotStats("srv-cancel-wait")).toEqual({ active: 1, waiters: 1 });

    r1();
    const r3 = await s3.ready;
    expect(__sshSessionSlotStats("srv-cancel-wait")).toEqual({ active: 1, waiters: 0 });

    r3();
    expect(__sshSessionSlotStats("srv-cancel-wait")).toEqual({ active: 0, waiters: 0 });
  });

  it("releases the slot if cancel() is called after grant and is idempotent", async () => {
    const s1 = acquireSshSessionSlot("srv-cancel-granted", 1);
    const r1 = await s1.ready;
    const s2 = acquireSshSessionSlot("srv-cancel-granted", 1);

    s1.cancel();
    s1.cancel();
    r1();

    const r2 = await s2.ready;
    expect(__sshSessionSlotStats("srv-cancel-granted")).toEqual({ active: 1, waiters: 0 });
    r2();
    expect(__sshSessionSlotStats("srv-cancel-granted")).toEqual({ active: 0, waiters: 0 });
  });

  it("bypasses limiting when maxSessions <= 0 or non-finite", async () => {
    const s1 = acquireSshSessionSlot("srv-unlimited", 0);
    const s2 = acquireSshSessionSlot("srv-unlimited", -1);
    const s3 = acquireSshSessionSlot("srv-unlimited", Number.NaN);
    const s4 = acquireSshSessionSlot("srv-unlimited", Number.POSITIVE_INFINITY);

    const [r1, r2, r3, r4] = await Promise.all([s1.ready, s2.ready, s3.ready, s4.ready]);
    expect(__sshSessionSlotStats("srv-unlimited")).toEqual({ active: 0, waiters: 0 });

    r1();
    r2();
    r3();
    r4();
    s1.cancel();
    s2.cancel();
  });
});
