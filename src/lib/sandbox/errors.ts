/**
 * Structured errors thrown by the sandbox layer.
 *
 * See docs/sandbox.md.
 */

export type SandboxErrorCode =
  | "NO_BACKEND"
  | "BACKEND_UNAVAILABLE"
  | "INVALID_INPUT"
  | "RUNTIME";

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

export class NoBackendError extends SandboxError {
  constructor(message: string) {
    super("NO_BACKEND", message);
    this.name = "NoBackendError";
  }
}

export class BackendUnavailableError extends SandboxError {
  constructor(backend: string, message: string) {
    super("BACKEND_UNAVAILABLE", `${backend}: ${message}`);
    this.name = "BackendUnavailableError";
  }
}

/**
 * Fail-closed refusal (BUG-11): code execution is *intentionally*
 * disabled because no isolated sandbox is configured — NOT a
 * misconfiguration. A subclass of BackendUnavailableError so existing
 * `instanceof BackendUnavailableError` handling (tool envelope) still
 * applies, but boot can log it softly instead of as an error.
 */
export class SandboxDisabledError extends BackendUnavailableError {
  constructor(message: string) {
    super("subprocess", message);
    this.name = "SandboxDisabledError";
  }
}

export class InvalidSandboxInputError extends SandboxError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "InvalidSandboxInputError";
  }
}
