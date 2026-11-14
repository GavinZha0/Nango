/**
 * A2A provider — single-entry registration. See docs/a2a-compatibility.md.
 */

import "server-only";

import type { BackendModule } from "../types";
import { a2aAdapter } from "./adapter";
import { a2aChatHandler } from "./chat.server";
import { fetchA2AEntitiesServer } from "./entity.server";

export const a2aBackend: BackendModule = {
  id: "a2a",
  capabilities: a2aAdapter.capabilities,
  controlPlane: {
    adapter: a2aAdapter,
    fetchEntities: fetchA2AEntitiesServer,
  },
  dataPlane: {
    chatHandler: a2aChatHandler,
  },
};
