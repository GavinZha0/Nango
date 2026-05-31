/**
 * Mastra backend adapter — client-side. See docs/backend-integration.md.
 */

import type {
  BackendCapabilities,
  IBackendAdapter,
} from "../types";

const capabilities: BackendCapabilities = {
  displayName: "Mastra",
  entityKinds: ["agent"],
};

export const mastraAdapter: IBackendAdapter = {
  provider: "mastra",
  capabilities,
};
