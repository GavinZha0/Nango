/**
 * Vitest unit-test setup.
 *
 * Runs once per worker before any test files import application code.
 * Use this file ONLY for environment plumbing that has to happen before
 * module imports — runtime behaviour mocks belong in the test files
 * themselves.
 */

// better-auth (transitively imported by several artifact / dashboard
// modules) emits a console.warn if BETTER_AUTH_URL is missing, because
// without it auth callbacks and redirects can't compute absolute URLs.
// Tests don't exercise those code paths, but the warn still floods the
// vitest output. Provide a dummy value to silence it. The actual value
// is irrelevant — no test makes auth callbacks.
process.env.BETTER_AUTH_URL ??= "http://localhost:9300";

import { vi, afterEach } from "vitest";
import { sharedLoggerSpies, resetSharedLogger } from "./helpers/mock-refs";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "test-request-id",
  childLogger: () => sharedLoggerSpies,
  logger: sharedLoggerSpies,
  timed: async (_log: unknown, _event: unknown, fn: () => Promise<unknown>) => fn(),
}));

afterEach(() => {
  resetSharedLogger();
});
