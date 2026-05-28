/**
 * agno provider — single-entry registration.
 */

import "server-only";

import type { BackendModule } from "../types";
import { agnoAdapter } from "./adapter";
import { agnoChatHandler } from "./chat.server";
import { fetchAgnoEntitiesServer } from "./entity.server";

export const agnoBackend: BackendModule = {
  id: "agno",
  capabilities: agnoAdapter.capabilities,
  controlPlane: {
    adapter: agnoAdapter,
    fetchEntities: fetchAgnoEntitiesServer,
  },
  dataPlane: {
    chatHandler: agnoChatHandler,
  },
};
