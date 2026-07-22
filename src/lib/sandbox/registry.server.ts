/**
 * Server-only sandbox-adapter registry + selection.
 *
 * See docs/sandbox.md.
 */

import "server-only";

import type { ISandboxAdapter, SandboxBackend } from "./types";
import { SANDBOX_BACKENDS } from "./types";
import { BackendUnavailableError, SandboxDisabledError, SandboxError } from "./errors";
import { getConfig, getConfigBoolean } from "@/lib/config";

import { SubprocessAdapter } from "./adapters/subprocess/adapter.server";
import { LocalDockerAdapter } from "./adapters/local-docker/adapter.server";

/** Default when SANDBOX_MODE unset. Subprocess works without external deps. */
const DEFAULT_MODE: SandboxBackend = "subprocess";

/**
 * CONTRACT: every `SANDBOX_BACKENDS` key has an entry. `satisfies Record<…>`
 * makes missing entries compile errors. Stubs reject at selection with
 * `BackendUnavailableError`.
 */
export const ADAPTERS = {
  subprocess: new SubprocessAdapter(),
  "local-docker": new LocalDockerAdapter(),
  "remote-docker": null as ISandboxAdapter | null,
} as const satisfies Record<SandboxBackend, ISandboxAdapter | null>;

let cachedActive: ISandboxAdapter | null = null;

/** Reset for tests; never called from production code. */
export function _resetActiveAdapterCache(): void {
  cachedActive = null;
}

/** Resolve active sandbox adapter for this process. Throws on unknown mode (typo guard) or unavailable backend. */
export async function getActiveAdapter(): Promise<ISandboxAdapter> {
  if (cachedActive) return cachedActive;

  const mode = parseSandboxMode(getConfig("sandbox.mode", "subprocess"));

  // SECURITY (BUG-11): fail-closed. The `subprocess` backend provides no
  // filesystem/network isolation, so it must be *explicitly* opted into
  // — never the silent default. Refuse code execution unless the
  // operator has acknowledged the risk via `sandbox.allow_insecure`.
  // `local-docker` / `remote-docker` are unaffected.
  if (mode === "subprocess" && !getConfigBoolean("sandbox.allow_insecure", false)) {
    throw new SandboxDisabledError(
      "Code execution is disabled: no isolated sandbox is configured. " +
        "Set sandbox.mode=local-docker (recommended), or — to accept the " +
        "degraded, unisolated subprocess backend — set " +
        "sandbox.allow_insecure=true explicitly.",
    );
  }

  const adapter = ADAPTERS[mode];
  if (!adapter) {
    throw new BackendUnavailableError(
      mode,
      `SANDBOX_MODE=${mode} is not implemented yet. Available modes: ` +
        `subprocess, local-docker. Pending: remote-docker.`,
    );
  }
  if (!(await adapter.isAvailable())) {
    throw new BackendUnavailableError(
      mode,
      `SANDBOX_MODE=${mode} but isAvailable() returned false. ` +
        `Fix the prerequisite (e.g. start Docker daemon) — there is ` +
        `no silent fallback.`,
    );
  }
  cachedActive = adapter;
  return adapter;
}

/** Parse SANDBOX_MODE env var. Empty/unset → subprocess. Unknown values throw at boot (typo guard). */
function parseSandboxMode(raw: string | undefined): SandboxBackend {
  if (!raw || raw.trim().length === 0) return DEFAULT_MODE;
  const v = raw.trim().toLowerCase();
  if ((SANDBOX_BACKENDS as readonly string[]).includes(v)) {
    return v as SandboxBackend;
  }
  throw new SandboxError(
    "INVALID_INPUT",
    `Unknown SANDBOX_MODE=${raw}. Expected one of: ${SANDBOX_BACKENDS.join(", ")}.`,
  );
}
