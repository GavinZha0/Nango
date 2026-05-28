/**
 * Mastra backend adapter — **client-side**.
 *
 * @see docs/backend-integration.md
 */

import type {
  BackendCapabilities,
  IBackendAdapter,
} from "../types";

// Capabilities

const capabilities: BackendCapabilities = {
  displayName: "Mastra",
  entityKinds: ["agent"],
};

// IBackendAdapter

export const mastraAdapter: IBackendAdapter = {
  provider: "mastra",
  capabilities,
};
