/**
 * Client-safe adapter registry. Components that need only static
 */

import type { IBackendAdapter, BackendId } from "./types";
import { BACKEND_IDS } from "./types";
import { agnoAdapter } from "./agno/adapter";
import { mastraAdapter } from "./mastra/adapter";
import { difyAdapter } from "./dify/adapter";

export const ADAPTERS = {
  agno: agnoAdapter,
  mastra: mastraAdapter,
  dify: difyAdapter,
} as const satisfies Record<BackendId, IBackendAdapter>;

export function getAdapter(provider: BackendId): IBackendAdapter {
  return ADAPTERS[provider];
}

/** All registered providers, in declaration order. Sourced from
 *  `BACKEND_IDS` so onboarding lives in one place. */
export const SUPPORTED_PROVIDERS: readonly BackendId[] = BACKEND_IDS;
