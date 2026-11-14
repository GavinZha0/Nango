/**
 * A2A backend metadata adapter — client-safe. See docs/a2a-compatibility.md.
 */

import type {
  BackendCapabilities,
  IBackendAdapter,
} from "../types";

const capabilities: BackendCapabilities = {
  displayName: "A2A",
  entityKinds: ["agent"],
};

export const a2aAdapter: IBackendAdapter = {
  provider: "a2a",
  capabilities,
};
