/**
 * LocalDockerAdapter — Docker-container sandbox backend.
 *
 * See docs/sandbox.md.
 */

import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type {
  ContainerRuntime,
  ISandboxAdapter,
  SandboxInput,
  SandboxOutput,
} from "../../types";
import { resolveContainerRuntime } from "../../types";
import { processStderr, processStdout } from "../../output";
import {
  buildMapping,
  DOCKER_CONTAINER_WORKDIR,
  resolveDatasetHostDir,
  SANDBOX_DATA_DIR,
} from "../../path-mapper";
import { getConfig, getConfigMs, getConfigNumber } from "@/lib/config";

const exec = promisify(execFile);

const DEFAULT_IMAGE = "sandbox-runner:latest";
const DEFAULT_TIMEOUT_S = 30;
const DEFAULT_MEMORY_MB = 256;
const DEFAULT_CPU_CORES = 0.8;
const DEFAULT_TMPFS_SIZE_MB = 512;

/** Test seam — production probes via `<runtime> info`. */
export interface ContainerProbe {
  isDaemonReachable(): Promise<boolean>;
}

function createDefaultProbe(runtime: ContainerRuntime): ContainerProbe {
  return {
    async isDaemonReachable() {
      try {
        await exec(runtime, ["info"]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export class LocalDockerAdapter implements ISandboxAdapter {
  readonly backend = "local-docker" as const;
  readonly displayName = "Local Docker";

  private readonly image: string;
  private readonly runtime: ContainerRuntime;

  constructor(
    private readonly probe?: ContainerProbe,
    image: string = getConfig("sandbox.image", DEFAULT_IMAGE),
    runtime: ContainerRuntime = resolveContainerRuntime(),
  ) {
    this.image = image;
    this.runtime = runtime;
  }

  async isAvailable(): Promise<boolean> {
    const p = this.probe ?? createDefaultProbe(this.runtime);
    return p.isDaemonReachable();
  }

  async run(input: SandboxInput): Promise<SandboxOutput> {
    if (input.command.length === 0) {
      throw new Error("SandboxInput.command must not be empty.");
    }

    const startedAt = Date.now();
    const tmpHostDir = await fs.mkdtemp(path.join(os.tmpdir(), "nango-sandbox-"));
    const containerName = `nango-sandbox-${randomUUID()}`;
    const mapping = buildMapping(tmpHostDir, input.datasets ?? []);

    try {
      // Materialize stdin / extra files into the bind-mounted dir.
      // The container sees them at ./<name> relative to /work (cwd).
      for (const [name, buf] of Object.entries(input.inputFiles ?? {})) {
        if (name.includes("..") || path.isAbsolute(name)) {
          throw new Error(`Invalid inputFiles key: ${name}`);
        }
        const target = path.join(tmpHostDir, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buf);
      }

      const args = this.buildDockerArgs(input, tmpHostDir, containerName);
      const child = spawn(this.runtime, args, { stdio: ["pipe", "pipe", "pipe"] });
      if (input.stdin !== undefined && child.stdin) {
        child.stdin.end(input.stdin);
      }

      const result = await this.driveChild(child, input, containerName);

      return {
        stdout: processStdout(result.rawStdout, mapping),
        stderr: processStderr(result.rawStderr, mapping),
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        ...(result.termination ? { termination: result.termination } : {}),
      };
    } finally {
      await fs.rm(tmpHostDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Internals

  /**
   * Visible for testing. Asserts the exact argv we pass to `docker`.
   * Pure function: no fs or network I/O.
   */
  buildDockerArgs(
    input: SandboxInput,
    tmpHostDir: string,
    containerName: string,
  ): string[] {
    const memMb = input.maxMemoryMb ?? getConfigNumber("sandbox.memory_mb", DEFAULT_MEMORY_MB);
    const cpu = input.maxCpuCores ?? getConfigNumber("sandbox.cpu_cores", DEFAULT_CPU_CORES);
    const tmpfsMb = getConfigNumber("sandbox.tmpfs_size_mb", DEFAULT_TMPFS_SIZE_MB);

    const args: string[] = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network=none",
      "--read-only",
      `--memory=${memMb}m`,
      `--cpus=${cpu}`,
      "--tmpfs",
      `/tmp:exec,size=${tmpfsMb}M`,
      "--init", // ensure signals propagate to argv[0]
      // Set the container's working directory to the cwd-relative
      // contract surface. LLM-generated Python sees
      // `os.getcwd() == "/work"` and resolves `./data/<name>/...`
      // relative to it. Docker auto-creates `/work` as a mount
      // point when the bind below attaches.
      "--workdir",
      DOCKER_CONTAINER_WORKDIR,
      // tmpHostDir → /work bind mount. NOT readonly — child writes
      // intermediate files (e.g. plot PNGs, intermediate Parquets)
      // here and they get cleaned up with tmpHostDir after the run,
      // matching the subprocess adapter's behaviour where cwd is
      // the host tmp dir directly. Anything sensitive still lives
      // in the container's read-only rootfs.
      "--mount",
      `type=bind,src=${tmpHostDir},dst=${DOCKER_CONTAINER_WORKDIR}`,
    ];

    // Forward host stdin to the container only when caller actually
    // supplies stdin. Without -i, `docker run` discards anything we
    // pipe into its stdin — `python3 -` then reads EOF immediately
    // and exits 0 with empty stdout, masking the lost script.
    if (input.stdin !== undefined) {
      args.push("-i");
    }

    // Per-dataset bind mount overlaying `/work/data/<name>`. The
    // overlay is independent of the `/work` mount above (Linux
    // bind mounts are additive), so `/work/data/<name>` resolves
    // to the host Parquet directory regardless of whether
    // `<tmpHostDir>/data/<name>` exists. `readonly` ensures the
    // shared cache can't be polluted by LLM-generated code.
    for (const dataset of input.datasets ?? []) {
      args.push(
        "--mount",
        `type=bind,src=${resolveDatasetHostDir(dataset)},` +
          `dst=${DOCKER_CONTAINER_WORKDIR}/${SANDBOX_DATA_DIR}/${dataset},` +
          "readonly",
      );
    }

    args.push(this.image, ...input.command);
    return args;
  }

  private async driveChild(
    child: ChildProcess,
    input: SandboxInput,
    containerName: string,
  ): Promise<DriveResult> {
    const timeoutMs = input.timeoutMs ?? getConfigMs("sandbox.timeout", DEFAULT_TIMEOUT_S);
    let rawStdout = "";
    let rawStderr = "";

    return new Promise<DriveResult>((resolve) => {
      let termination: SandboxOutput["termination"];
      let settled = false;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
        resolve({ rawStdout, rawStderr, exitCode, termination });
      };

      // Killing `docker run` by signal does not always kill the
      // container; ask the daemon to stop the named container directly.
      const killContainer = (
        reason: NonNullable<SandboxOutput["termination"]>,
      ) => {
        if (settled) return;
        termination = reason;
        exec(this.runtime, ["kill", containerName]).catch(() => {
          // Container may already have exited; the close handler
          // will resolve regardless.
        });
      };

      const killTimer = setTimeout(() => killContainer("timeout"), timeoutMs);

      const onAbort = () => killContainer("abort");
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (d: Buffer) => {
        rawStdout += d.toString("utf-8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        rawStderr += d.toString("utf-8");
      });

      child.on("error", (err) => {
        // Spawn-level failure (docker CLI missing). Surface as 127.
        rawStderr += `${err.message}\n`;
        finish(127);
      });

      child.on("close", (code, signal) => {
        if (termination === undefined && signal !== null) {
          termination = "signal";
        }
        const exitCode = (() => {
          if (termination === "timeout") return 124;
          if (code !== null) return code;
          return 137;
        })();
        finish(exitCode);
      });
    });
  }
}

interface DriveResult {
  rawStdout: string;
  rawStderr: string;
  exitCode: number;
  termination: SandboxOutput["termination"];
}
