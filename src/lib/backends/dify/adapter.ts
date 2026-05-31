/**
 * Dify backend metadata adapter — client-side. See docs/backend-integration.md.
 */

import type {
  BackendCapabilities,
  IBackendAdapter,
} from "../types";

const capabilities: BackendCapabilities = {
  displayName: "Dify",
  entityKinds: ["agent"],
};

export const difyAdapter: IBackendAdapter = {
  provider: "dify",
  capabilities,
};
