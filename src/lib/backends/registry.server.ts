/**
 * Backend provider registry — server-only.
 */

import "server-only";

import type {
  IBackendChatHandler,
  BackendId,
  BackendModule,
} from "./types";
import { isSupportedBackend } from "./types";
import { agnoBackend } from "./agno/index.server";
import { difyBackend } from "./dify/index.server";
import { mastraBackend } from "./mastra/index.server";

export const BACKENDS = {
  agno: agnoBackend,
  mastra: mastraBackend,
  dify: difyBackend,
} as const satisfies Record<BackendId, BackendModule>;

export function getBackend(id: BackendId): BackendModule {
  return BACKENDS[id];
}

/** CONTRACT: returns null on unknown / untrusted input. Same shape
 *  as the legacy `chat-registry.server.ts` export. */
export function getChatHandler(
  provider: string | null | undefined,
): IBackendChatHandler | null {
  return isSupportedBackend(provider)
    ? BACKENDS[provider].dataPlane.chatHandler
    : null;
}
