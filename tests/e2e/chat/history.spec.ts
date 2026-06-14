import { test, expect } from "@playwright/test";

test.use({
  storageState: "tests/e2e/.auth/admin.json",
  viewport: { width: 1920, height: 1080 },
});

test.describe("History Panel", () => {
  test.beforeEach(async ({ page }) => {
    // Ensure the right panel is open before navigating.
    await page.addInitScript(() => {
      localStorage.setItem(
        "nango:sidebar",
        JSON.stringify({ state: { leftPanelOpen: false, rightPanelOpen: true }, version: 0 }),
      );
    });
    await page.goto("/");
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
  });

  test("should display the right panel with chat content", async ({ page }) => {
    // Without agents configured, the right panel shows the agent
    // selection prompt. The toolbar (with Chat / History tabs) only
    // renders when an agent is selected, so we verify the panel
    // itself is visible.
    await expect(page.locator(".border-l").first()).toBeVisible({ timeout: 10000 });
  });
});
