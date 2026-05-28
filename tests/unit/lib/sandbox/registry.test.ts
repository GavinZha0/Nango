import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let mockSandboxMode = "subprocess";
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
import { BackendUnavailableError, SandboxError } from "@/lib/sandbox/errors";
import { SANDBOX_BACKENDS } from "@/lib/sandbox/types";

beforeEach(() => {
  _resetActiveAdapterCache();
  mockSandboxMode = "subprocess";
});

afterEach(() => {
  _resetActiveAdapterCache();
});

describe("sandbox registry — adapter table", () => {
  it("declares an entry for every SANDBOX_BACKENDS id", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...SANDBOX_BACKENDS].sort());
  });

  it("subprocess + local-docker shipped; remote-docker still null", () => {
    expect(ADAPTERS.subprocess).not.toBeNull();
    expect(ADAPTERS.subprocess?.backend).toBe("subprocess");
    expect(ADAPTERS["local-docker"]).not.toBeNull();
    expect(ADAPTERS["local-docker"]?.backend).toBe("local-docker");
    expect(ADAPTERS["remote-docker"]).toBeNull();
  });
});

describe("sandbox registry — sandbox.mode selection (always explicit)", () => {
  it("defaults to subprocess", async () => {
    const a = await getActiveAdapter();
    expect(a.backend).toBe("subprocess");
  });

  it("sandbox.mode=subprocess → subprocess adapter", async () => {
    mockSandboxMode = "subprocess";
    const a = await getActiveAdapter();
    expect(a.backend).toBe("subprocess");
  });

  it("sandbox.mode=remote-docker throws BackendUnavailableError (stub)", async () => {
    mockSandboxMode = "remote-docker";
    await expect(getActiveAdapter()).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it("sandbox.mode=nsjail is rejected as unknown (removed from backends)", async () => {
    mockSandboxMode = "nsjail";
    await expect(getActiveAdapter()).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects unknown mode values at parse time (typo guard)", async () => {
    mockSandboxMode = "docker";
    await expect(getActiveAdapter()).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects 'auto' (auto mode is gone)", async () => {
    mockSandboxMode = "auto";
    await expect(getActiveAdapter()).rejects.toBeInstanceOf(SandboxError);
  });

  it("caches the resolved adapter across calls", async () => {
    mockSandboxMode = "subprocess";
    const a = await getActiveAdapter();
    const b = await getActiveAdapter();
    expect(a).toBe(b);
  });
});
