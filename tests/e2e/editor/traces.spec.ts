import { test, expect } from "@playwright/test";

// Use saved editor auth state so we skip sign-in
test.use({ storageState: "tests/e2e/.auth/editor.json" });

test.describe("Trace Management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/trace");
    // Wait for navigation to settle (don't use networkidle — CopilotKit keeps polling)
    await page.waitForTimeout(2000);
    // Remove CopilotKit dev inspector overlay that intercepts pointer events
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // If not on trace page, skip all tests
    if (!page.url().includes("/trace")) {
      test.skip(true, "Test user does not have access — first DB user was not our test user");
    }
    // Wait for the page content to load
    await expect(page.getByRole("heading", { name: "Traces", exact: true })).toBeVisible({ timeout: 10000 });
  });

  test("should display the traces page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Traces", exact: true })).toBeVisible();
  });
});
