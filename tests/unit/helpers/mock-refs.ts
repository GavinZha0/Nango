import { vi } from "vitest";

function createLoggerMethods() {
  const logObj = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };
  logObj.child.mockReturnValue(logObj);
  return logObj;
}

export const sharedLoggerSpies = createLoggerMethods();

/**
 * Resets calls on all shared logger spy methods.
 */
export function resetSharedLogger(): void {
  sharedLoggerSpies.debug.mockReset();
  sharedLoggerSpies.info.mockReset();
  sharedLoggerSpies.warn.mockReset();
  sharedLoggerSpies.error.mockReset();
  sharedLoggerSpies.fatal.mockReset();
  sharedLoggerSpies.trace.mockReset();
  sharedLoggerSpies.child.mockReset();
  sharedLoggerSpies.child.mockReturnValue(sharedLoggerSpies);
}
