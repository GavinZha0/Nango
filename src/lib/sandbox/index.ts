/**
 * Sandbox subsystem entry — pure types + error classes. Server-only
 * pieces (`getActiveAdapter`, adapters) live in `registry.server.ts`
 * and the per-backend files; import those directly when you need
 * them.
 *
 * See docs/sandbox.md.
 */

export type {
  ISandboxAdapter,
  SandboxBackend,
  SandboxInput,
  SandboxOutput,
} from "./types";
export { SANDBOX_BACKENDS } from "./types";
export {
  SandboxError,
  NoBackendError,
  BackendUnavailableError,
  InvalidSandboxInputError,
} from "./errors";
