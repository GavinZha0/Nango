/**
 * Structured errors thrown by the sandbox layer.
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

export class InvalidSandboxInputError extends SandboxError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "InvalidSandboxInputError";
  }
}
