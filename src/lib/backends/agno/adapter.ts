/**
 * agno backend adapter — **client-side**.
 *
 * @see docs/backend-integration.md
 */

import type {
  BackendCapabilities,
  IBackendAdapter,
} from "../types";

// Capabilities

const capabilities: BackendCapabilities = {
  displayName: "agno",
  entityKinds: ["agent", "team", "workflow"],
};

// IBackendAdapter

export const agnoAdapter: IBackendAdapter = {
  provider: "agno",
  capabilities,
};
