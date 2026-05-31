/**
 * agno backend adapter — client-side. See docs/backend-integration.md.
 */

import type {
  BackendCapabilities,
  IBackendAdapter,
} from "../types";

const capabilities: BackendCapabilities = {
  displayName: "agno",
  entityKinds: ["agent", "team", "workflow"],
};

export const agnoAdapter: IBackendAdapter = {
  provider: "agno",
  capabilities,
};
