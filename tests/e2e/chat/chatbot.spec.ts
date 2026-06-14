import { test, expect } from "@playwright/test";

test.use({
  storageState: "tests/e2e/.auth/admin.json",
  viewport: { width: 1920, height: 1080 },
});

test.describe("Chat Panel", () => {
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

  test("should display the right panel", async ({ page }) => {
    // The right panel should be visible with its border-l class
    await expect(page.locator(".border-l").first()).toBeVisible({ timeout: 10000 });
  });

  test("should show agent selection prompt when no agent is configured", async ({ page }) => {
    // Without any agents configured, the panel shows the selection prompt
    await expect(
      page.getByText("Select an agent to start chatting."),
    ).toBeVisible({ timeout: 10000 });
  });
});
