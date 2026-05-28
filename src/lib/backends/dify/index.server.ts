/**
 * Dify provider — single-entry registration. See agno's
 * index.server.ts for the rationale; one BackendModule per platform.
 */

import "server-only";

import type { BackendModule } from "../types";
import { difyAdapter } from "./adapter";
import { difyChatHandler } from "./chat.server";
import { fetchDifyEntitiesServer } from "./entity.server";

export const difyBackend: BackendModule = {
  id: "dify",
  capabilities: difyAdapter.capabilities,
  controlPlane: {
    adapter: difyAdapter,
    fetchEntities: fetchDifyEntitiesServer,
  },
  dataPlane: {
    chatHandler: difyChatHandler,
  },
};
