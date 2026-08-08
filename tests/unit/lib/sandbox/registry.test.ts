import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config", () => ({
  getConfig: (_key: string, defaultValue: string) => defaultValue,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigBoolean: (_key: string, defaultValue: boolean) => defaultValue,
}));

import {
  ADAPTERS,
  getActiveAdapter,
  _resetActiveAdapterCache,
} from "@/lib/sandbox/registry.server";
import { SANDBOX_BACKENDS } from "@/lib/sandbox/types";

beforeEach(() => {
  _resetActiveAdapterCache();
  vi.spyOn(ADAPTERS.service, "isAvailable").mockResolvedValue(true);
});

afterEach(() => {
  _resetActiveAdapterCache();
});

describe("sandbox registry — adapter table", () => {
  it("declares only the service backend", () => {
    expect(Object.keys(ADAPTERS)).toEqual(["service"]);
  });

  it("SANDBOX_BACKENDS contains only 'service'", () => {
    expect([...SANDBOX_BACKENDS]).toEqual(["service"]);
  });

  it("service backend is initialized", () => {
    expect(ADAPTERS.service).not.toBeNull();
    expect(ADAPTERS.service?.backend).toBe("service");
  });
});

describe("sandbox registry — adapter selection", () => {
  it("returns the service adapter", async () => {
    const a = await getActiveAdapter();
    expect(a.backend).toBe("service");
  });

  it("throws when service is unavailable", async () => {
    vi.spyOn(ADAPTERS.service, "isAvailable").mockResolvedValue(false);
    await expect(getActiveAdapter()).rejects.toThrow("Sandbox service is not reachable");
  });

  it("caches the resolved adapter across calls", async () => {
    const a = await getActiveAdapter();
    const b = await getActiveAdapter();
    expect(a).toBe(b);
  });
});
