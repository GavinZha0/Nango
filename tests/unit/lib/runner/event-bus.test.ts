import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/schema", () => ({}));

import { subscribe, publish, type RunnerEvent } from "@/lib/runner/event-bus";

afterEach(() => {
  // Unsubscribe doesn't expose a "clear all" — tests must hold their
  // own unsub handles.
});

const event: RunnerEvent = {
  kind: "run_finalized",
  runId: "r-1",
  ownerId: "u-1",
  status: "succeeded",
};

describe("subscribe + publish", () => {
  it("delivers events to matching ownerId", () => {
    const fn = vi.fn();
    const unsub = subscribe("u-1", fn);
    publish("u-1", event);
    expect(fn).toHaveBeenCalledExactlyOnceWith(event);
    unsub();
  });

  it("does not deliver to a different ownerId", () => {
    const fn = vi.fn();
    const unsub = subscribe("u-2", fn);
    publish("u-1", event);
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it("fans out to multiple subscribers for the same owner", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const unsub1 = subscribe("u-1", fn1);
    const unsub2 = subscribe("u-1", fn2);
    publish("u-1", event);
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
    unsub1();
    unsub2();
  });

  it("unsubscribe stops delivery", () => {
    const fn = vi.fn();
    const unsub = subscribe("u-1", fn);
    unsub();
    publish("u-1", event);
    expect(fn).not.toHaveBeenCalled();
  });

  it("publish is a no-op when nobody listens", () => {
    // Should not throw
    expect(() => publish("nobody", event)).not.toThrow();
  });

  it("a throwing subscriber does not prevent others from receiving", () => {
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    const unsub1 = subscribe("u-1", bad);
    const unsub2 = subscribe("u-1", good);
    publish("u-1", event);
    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
    unsub1();
    unsub2();
  });

  it("double unsubscribe is safe", () => {
    const fn = vi.fn();
    const unsub = subscribe("u-1", fn);
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});
