/**
 * Verification subsystem — barrel re-exports.
 *
 * Phase 3 API routes import everything from here. Internal cross-module
 * imports use the file-level paths (avoids circular-import surprises).
 *
 * See docs/verification.md.
 */

import "server-only";

export * from "./types";
export * as storage from "./storage";
export { runMcpCase } from "./runner-mcp";
export { startSuiteRun } from "./run-orchestrator";
export { runAssertions } from "./assertions";
export { classifyMcpError } from "./error-source";
export { publishVerificationFrame } from "./event-bus-channel";
export { recoverStrandedVerificationRuns } from "./recovery";
