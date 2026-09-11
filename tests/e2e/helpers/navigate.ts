import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Shared navigation helpers. CopilotKit keeps an SSE / polling channel open
 * for the lifetime of the app, so tests can never rely on `networkidle`.
 * These helpers replace the previous per-spec boilerplate
 * (`goto` + `waitForTimeout` + inspect-overlay removal) with a single
 * "navigate then wait for a visible settle anchor" step.
 *
 * The cpk-web-inspector overlay is permanently suppressed via addInitScript
 * in helpers/fixtures.ts, so gotoSettled no longer needs to strip it on
 * every navigation. removeCopilotInspector is retained for non-fixture
 * contexts (e.g. setup.global.ts).
 */

const SETTLE_TIMEOUT_MS = 10_000;

/**
 * Remove the CopilotKit dev-inspector overlay. It sits on top of the page
 * and silently swallows pointer events, so clicks miss their target when it
 * is present. Kept for non-fixture contexts where addInitScript is not
 * active (e.g. setup.global.ts).
 */
export async function removeCopilotInspector(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
  });
}

export interface GotoSettledOptions {
  /**
   * When set, self-skip the current test if navigation landed on a different
   * path — i.e. the authenticated session lacks the required role (dirty DB
   * where the first user was not our seeded admin).
   */
  accessPath?: string;
  timeout?: number;
}

/**
 * Navigate to `path`, optionally self-skip when the session lacks access to
 * `accessPath`, then wait for `anchor` to become visible. Prefer this over
 * `page.goto(...)` + `waitForTimeout`, which is both slower and
 * timing-fragile.
 */
export async function gotoSettled(
  page: Page,
  path: string,
  anchor: Locator,
  options: GotoSettledOptions = {},
): Promise<void> {
  await page.goto(path);
  if (options.accessPath && !page.url().includes(options.accessPath)) {
    test.skip(true, `Not on ${options.accessPath} after navigating to ${path}: session lacks access.`);
  }
  await expect(anchor).toBeVisible({ timeout: options.timeout ?? SETTLE_TIMEOUT_MS });
}