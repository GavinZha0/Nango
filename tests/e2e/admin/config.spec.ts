import { test, expect } from "@playwright/test";

// Use saved admin auth state so we skip sign-in
test.use({ storageState: "tests/e2e/.auth/admin.json" });

test.describe("Config Management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/config");
    // Wait for navigation to settle (don't use networkidle — CopilotKit keeps polling)
    await page.waitForTimeout(2000);
    // Remove CopilotKit dev inspector overlay that intercepts pointer events
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // If not on admin page (user lacks admin role), skip all tests
    if (!page.url().includes("/admin/config")) {
      test.skip(true, "Test user does not have admin access — first DB user was not our test user");
    }
    // Wait for the page content to load
    await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible({ timeout: 10000 });
  });

  test("should display the config page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible();
  });
});
