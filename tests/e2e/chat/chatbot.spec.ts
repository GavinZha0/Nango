import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";

adminTest.use({ viewport: { width: 1920, height: 1080 } });

adminTest.describe("Chat Panel", () => {
  adminTest.beforeEach(async ({ page }) => {
    // Ensure the right panel is open before navigating.
    await page.addInitScript(() => {
      localStorage.setItem(
        "nango:sidebar",
        JSON.stringify({ state: { leftPanelOpen: false, rightPanelOpen: true }, version: 0 }),
      );
    });
  });

  adminTest("should display the right panel", async ({ page }) => {
    await gotoSettled(page, "/", page.locator(".border-l").first());
  });

  adminTest("should show agent selection prompt when no agent is configured", async ({ page }) => {
    // Mock APIs to return empty lists, simulating no configured agents
    await page.route("**/api/builtin-agents*", async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });
    await page.route("**/api/agent-credentials*", async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });

    await gotoSettled(page, "/", page.getByText("Select an agent to start chatting."));
  });
});
