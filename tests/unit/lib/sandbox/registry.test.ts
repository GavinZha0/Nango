import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let mockSandboxMode = "service";
vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) => {
    if (key === "sandbox.mode") return mockSandboxMode;
    return defaultValue;
  },
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigBoolean: (_key: string, defaultValue: boolean) => defaultValue,
}));

import {
  ADAPTERS,
  getActiveAdapter,
  _resetActiveAdapterCache,
} from "@/lib/sandbox/registry.server";
import { SandboxError } from "@/lib/sandbox/errors";
import { SANDBOX_BACKENDS } from "@/lib/sandbox/types";

beforeEach(() => {
  _resetActiveAdapterCache();
  mockSandboxMode = "service";
  vi.spyOn(ADAPTERS.service, "isAvailable").mockResolvedValue(true);
});

afterEach(() => {
  _resetActiveAdapterCache();
});

describe("sandbox registry — adapter table", () => {
  it("declares an entry for every SANDBOX_BACKENDS id", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...SANDBOX_BACKENDS].sort());
  });

  it("subprocess + service backends are initialized", () => {
    expect(ADAPTERS.subprocess).not.toBeNull();
    expect(ADAPTERS.subprocess?.backend).toBe("subprocess");
    expect(ADAPTERS.service).not.toBeNull();
    expect(ADAPTERS.service?.backend).toBe("service");
  });
});

describe("sandbox registry — sandbox.mode selection", () => {
  it("sandbox.mode=service → service adapter (default)", async () => {
    mockSandboxMode = "service";
    const a = await getActiveAdapter();
    expect(a.backend).toBe("service");
  });

  it("sandbox.mode=subprocess → subprocess adapter", async () => {
    mockSandboxMode = "subprocess";
    const a = await getActiveAdapter();
    expect(a.backend).toBe("subprocess");
  });

  it("sandbox.mode=nsjail is rejected as unknown (removed from backends)", async () => {
    mockSandboxMode = "nsjail";
    await expect(getActiveAdapter()).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects unknown mode values at parse time (typo guard)", async () => {
    mockSandboxMode = "docker";
    await expect(getActiveAdapter()).rejects.toBeInstanceOf(SandboxError);
  });

  it("caches the resolved adapter across calls", async () => {
    mockSandboxMode = "service";
    const a = await getActiveAdapter();
    const b = await getActiveAdapter();
    expect(a).toBe(b);
  });
});
