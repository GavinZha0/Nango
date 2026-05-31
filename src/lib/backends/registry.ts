/**
 * Client-safe adapter registry. See docs/backend-integration.md.
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

export const SUPPORTED_PROVIDERS: readonly BackendId[] = BACKEND_IDS;
