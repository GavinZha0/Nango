/**
 * Mastra provider — single-entry registration. See agno's
 * index.server.ts for the rationale; one BackendModule per platform.
 */

import "server-only";

import type { BackendModule } from "../types";
import { mastraAdapter } from "./adapter";
import { mastraChatHandler } from "./chat.server";
import { fetchMastraEntitiesServer } from "./entity.server";

export const mastraBackend: BackendModule = {
  id: "mastra",
  capabilities: mastraAdapter.capabilities,
  controlPlane: {
    adapter: mastraAdapter,
    fetchEntities: fetchMastraEntitiesServer,
  },
  dataPlane: {
    chatHandler: mastraChatHandler,
  },
};
