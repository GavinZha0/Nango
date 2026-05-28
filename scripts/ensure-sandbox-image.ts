/**
 * ensure-sandbox-image — build the LocalDockerAdapter's runtime image
 * if it isn't already in the local registry.
 *
 * Wired to `predev` / `prestart` so a fresh checkout boots without a
 * manual `docker build`. Tolerant when Docker is unreachable: prints
 * a warning and exits 0 so dev environments without Docker can still
 * run (LocalDockerAdapter falls back to subprocess at runtime).
 *
 * @see docs/sandbox.md §3.3
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const exec = promisify(execFile);

// NOTE: this script runs via tsx before Next.js boots, so it cannot
// use the config service (DB not available). It reads defaults from
// the config defaults module (pure code, no DB) and allows env
// overrides for CI / Docker-build contexts.
import { CONFIG_DEFAULTS_MAP } from "@/lib/config/defaults";

const IMAGE = process.env.SANDBOX_IMAGE
  ?? CONFIG_DEFAULTS_MAP.get("sandbox.image")?.value
  ?? "sandbox-runner:latest";
const DOCKERFILE_DIR = path.resolve(process.cwd(), "docker", "sandbox");

function resolveRuntime(): string {
  const raw = (
    process.env.SANDBOX_RUNTIME
    ?? CONFIG_DEFAULTS_MAP.get("sandbox.runtime")?.value
    ?? "docker"
  ).trim().toLowerCase();
  if (raw === "docker") return "docker";
  if (raw === "podman") return "podman";
  throw new Error(`Unknown sandbox runtime: ${raw}. Expected: docker, podman.`);
}

const RUNTIME = resolveRuntime();

async function runtimeAvailable(): Promise<boolean> {
  try {
    await exec(RUNTIME, ["info"]);
    return true;
  } catch {
    return false;
  }
}

async function imageExists(image: string): Promise<boolean> {
  try {
    const { stdout } = await exec(RUNTIME, ["images", "-q", image]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function buildImage(image: string, contextDir: string): Promise<void> {
  console.log(`[sandbox] building ${image} via ${RUNTIME} (~30s, first run only)…`);
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      RUNTIME,
      ["build", "-t", image, "-f", path.join(contextDir, "Dockerfile"), contextDir],
      { stdio: "inherit" },
    );
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${RUNTIME} build exited ${code}`)),
    );
  });
}

async function main(): Promise<void> {
  if (!(await runtimeAvailable())) {
    console.warn(
      `[sandbox] ${RUNTIME} daemon not reachable; skipping sandbox image build. ` +
        "LocalDockerAdapter will be unavailable; runtime falls back to " +
        "SubprocessAdapter (degraded). Install Docker or Podman for real isolation.",
    );
    return;
  }
  if (await imageExists(IMAGE)) {
    return;
  }
  try {
    await buildImage(IMAGE, DOCKERFILE_DIR);
    console.log(`[sandbox] ${IMAGE} ready.`);
  } catch (err) {
    console.warn(
      `[sandbox] failed to build ${IMAGE}: ${err instanceof Error ? err.message : err}. ` +
        "Continuing without the image; LocalDockerAdapter will be unavailable.",
    );
  }
}

main().catch((err: unknown) => {
  console.warn(
    `[sandbox] ensure-sandbox-image failed: ${err instanceof Error ? err.message : err}`,
  );
});
