import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) => {
    if (key === "datasource.cache_root") return "/data/cache-test";
    return defaultValue;
  },
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigBoolean: (_key: string, defaultValue: boolean) => defaultValue,
}));

import { LocalDockerAdapter } from "@/lib/sandbox/adapters/local-docker/adapter.server";

describe("LocalDockerAdapter — argv assembly (pure)", () => {
  const adapter = new LocalDockerAdapter(
    { isDaemonReachable: async () => true },
    "sandbox-runner:test",
  );

  it("includes mandatory hardening flags + image + command", () => {
    const argv = adapter.buildDockerArgs(
      { command: ["python3", "./x.py"], timeoutMs: 5000 },
      "/tmp/sandbox-host-abc",
      "nango-sandbox-1",
    );
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--rm");
    expect(argv).toContain("--network=none");
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--memory=256m"); // default
    expect(argv).toContain("--cpus=0.8");    // default
    expect(argv).toContain("--init");
    expect(argv).toContain("--name");
    // Container name immediately follows --name
    expect(argv[argv.indexOf("--name") + 1]).toBe("nango-sandbox-1");
    // Image, then argv (cwd-relative path per D38 — file resolves
    // against the container's --workdir /work).
    expect(argv).toContain("sandbox-runner:test");
    const imgIdx = argv.indexOf("sandbox-runner:test");
    expect(argv.slice(imgIdx + 1)).toEqual(["python3", "./x.py"]);
  });

  it("respects custom memory + cpu caps", () => {
    const argv = adapter.buildDockerArgs(
      { command: ["true"], maxMemoryMb: 512, maxCpuCores: 1.5 },
      "/tmp/x",
      "nango-sandbox-x",
    );
    expect(argv).toContain("--memory=512m");
    expect(argv).toContain("--cpus=1.5");
  });

  it("sets the container working directory to /work (D38)", () => {
    const argv = adapter.buildDockerArgs(
      { command: ["true"] },
      "/tmp/x",
      "nango-sandbox-x",
    );
    const idx = argv.indexOf("--workdir");
    expect(idx).toBeGreaterThan(0);
    expect(argv[idx + 1]).toBe("/work");
  });

  it("mounts the per-call work dir WRITABLE at /work (D38)", () => {
    // Writable so LLM-generated Python can save intermediate
    // files alongside `./data/<name>/` reads — matches subprocess
    // adapter parity (where tmpHostDir IS the writable cwd).
    const argv = adapter.buildDockerArgs(
      { command: ["true"] },
      "/tmp/sandbox-host-xyz",
      "nango-sandbox-x",
    );
    const workMount = argv
      .filter((_, i) => argv[i - 1] === "--mount")
      .find((m) => m.includes("dst=/work"));
    expect(workMount).toBe(
      "type=bind,src=/tmp/sandbox-host-xyz,dst=/work",
    );
    // The container's read-only rootfs still protects everything
    // outside the bind mounts; we just opt /work into write
    // access.
    expect(workMount).not.toContain("readonly");
  });

  it("mounts requested datasets READONLY at /work/data/<name> (D38)", () => {
    const argv = adapter.buildDockerArgs(
      { command: ["true"], datasets: ["sales_q1", "customers"] },
      "/tmp/x",
      "nango-sandbox-x",
    );
    const mounts = argv
      .filter((_, i) => argv[i - 1] === "--mount")
      .filter((m) => m.includes("/work/data/"));
    expect(mounts).toHaveLength(2);
    expect(mounts).toContain(
      "type=bind,src=/data/cache-test/parquet/sales_q1,dst=/work/data/sales_q1,readonly",
    );
    expect(mounts).toContain(
      "type=bind,src=/data/cache-test/parquet/customers,dst=/work/data/customers,readonly",
    );
  });

  it("does NOT expose legacy /mnt/cache or /mnt/tmp paths (D38)", () => {
    const argv = adapter.buildDockerArgs(
      { command: ["true"], datasets: ["sales_q1"] },
      "/tmp/x",
      "nango-sandbox-x",
    );
    const flat = argv.join(" ");
    expect(flat).not.toContain("/mnt/cache");
    expect(flat).not.toContain("/mnt/tmp");
  });

  it("adds -i when caller supplies stdin (so docker forwards it)", () => {
    const argv = adapter.buildDockerArgs(
      { command: ["python3", "-"], stdin: "print('hi')" },
      "/tmp/x",
      "nango-sandbox-x",
    );
    expect(argv).toContain("-i");
  });

  it("omits -i when caller does NOT supply stdin", () => {
    const argv = adapter.buildDockerArgs(
      { command: ["python3", "-c", "print('hi')"] },
      "/tmp/x",
      "nango-sandbox-x",
    );
    expect(argv).not.toContain("-i");
  });

  it("declares a writable tmpfs at /tmp inside the container", () => {
    const argv = adapter.buildDockerArgs(
      { command: ["true"] },
      "/tmp/x",
      "nango-sandbox-x",
    );
    const tmpfsIdx = argv.indexOf("--tmpfs");
    expect(tmpfsIdx).toBeGreaterThan(0);
    expect(argv[tmpfsIdx + 1]).toMatch(/^\/tmp:exec,size=/);
  });
});

describe("LocalDockerAdapter — isAvailable", () => {
  it("delegates to the docker probe", async () => {
    const reachable = new LocalDockerAdapter({ isDaemonReachable: async () => true });
    expect(await reachable.isAvailable()).toBe(true);
    const dead = new LocalDockerAdapter({ isDaemonReachable: async () => false });
    expect(await dead.isAvailable()).toBe(false);
  });
});

describe("LocalDockerAdapter — input validation", () => {
  const adapter = new LocalDockerAdapter({ isDaemonReachable: async () => true });

  it("rejects empty command", async () => {
    await expect(adapter.run({ command: [] })).rejects.toThrow(/command/);
  });

  it("rejects path-traversal in inputFiles keys", async () => {
    await expect(
      adapter.run({
        command: ["true"],
        inputFiles: { "../escape": Buffer.from("x") },
      }),
    ).rejects.toThrow(/Invalid inputFiles/);
  });
});
