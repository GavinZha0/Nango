/**
 * Server-only sandbox-adapter registry + selection.
 *
 * Nango uses `dify-sandbox` (service mode) as its sole sandbox backend.
 * See docs/sandbox.md.
 */

import "server-only";

import type { ISandboxAdapter } from "./types";
import { BackendUnavailableError } from "./errors";
import { getEnabledInfrastructureCredentialByProvider } from "@/lib/credentials/lookup";

import { ServiceSandboxAdapter } from "./adapters/service/adapter.server";

/**
 * CONTRACT: the service adapter is the only sandbox backend.
 * The subprocess fallback was removed to allow Python to be
 * stripped from the main container image.
 */
export const ADAPTERS = {
  service: new ServiceSandboxAdapter(),
} as const;

let cachedActive: ISandboxAdapter | null = null;

/** Reset for tests; never called from production code. */
export function _resetActiveAdapterCache(): void {
  cachedActive = null;
}

/** Resolve active sandbox adapter for this process. Throws if the service is unavailable. */
export async function getActiveAdapter(): Promise<ISandboxAdapter> {
  if (cachedActive) return cachedActive;

  const adapter = ADAPTERS.service;
  if (!(await adapter.isAvailable())) {
    let hasCred = false;
    try {
      const cred = await getEnabledInfrastructureCredentialByProvider("dify-sandbox");
      hasCred = Boolean(cred?.host?.trim());
    } catch {
      // DB/lookup unavailable in unit tests or early boot; fall through to generic message.
      hasCred = true;
    }
    if (!hasCred) {
      throw new BackendUnavailableError(
        "service",
        "Sandbox service is not configured. Add an enabled 'Dify Sandbox' credential with its service URL in Admin → Credentials.",
      );
    }
    throw new BackendUnavailableError(
      "service",
      "Sandbox service is not reachable. Ensure the external sandbox service is running and verify its URL in Admin → Credentials.",
    );
  }
  cachedActive = adapter;
  return adapter;
}
