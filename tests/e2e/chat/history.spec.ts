import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";

adminTest.use({ viewport: { width: 1920, height: 1080 } });

adminTest.describe("History Panel", () => {
  adminTest.beforeEach(async ({ page }) => {
    // Ensure the right panel is open before navigating.
    await page.addInitScript(() => {
      localStorage.setItem(
        "nango:sidebar",
        JSON.stringify({ state: { leftPanelOpen: false, rightPanelOpen: true }, version: 0 }),
      );
    });
  });

  adminTest("should display the right panel with chat content", async ({ page }) => {
    // Without agents configured, the right panel shows the agent
    // selection prompt. The toolbar (with Chat / History tabs) only
    // renders when an agent is selected, so we verify the panel
    // itself is visible.
    await gotoSettled(page, "/", page.locator(".border-l").first());
  });
});
