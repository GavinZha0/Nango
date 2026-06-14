import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/user.json" });

test.describe("Dashboard Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // The /dashboard route renders the WelcomePage with "Welcome to Nango"
    await expect(
      page.getByRole("heading", { name: /Welcome to Nango/i }),
    ).toBeVisible({ timeout: 10000 });
  });

  test("should display the dashboard page with welcome content", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /Welcome to Nango/i }),
    ).toBeVisible();
  });

  test("should display the left toolbar", async ({ page }) => {
    // The left toolbar is the fixed-width vertical icon bar on the far left
    await expect(page.locator('[data-panel="dashboard"]')).toBeVisible();
  });
});
