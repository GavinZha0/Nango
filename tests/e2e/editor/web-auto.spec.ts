import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/editor.json" });

test.describe("Web Auto Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/web-auto");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // /web-auto is a panel-redirect page — center shows WelcomePage
    await expect(page.getByRole("heading", { name: "Welcome to Nango" })).toBeVisible({ timeout: 10000 });
  });

  test("should display the web auto page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Welcome to Nango" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Web Auto" }).first()).toBeVisible();
  });
});