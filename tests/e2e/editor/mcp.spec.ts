import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/editor.json" });

test.describe("MCP Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/mcp");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // /mcp is a panel-redirect page — center shows WelcomePage
    await expect(page.getByRole("heading", { name: "Welcome to Nango" })).toBeVisible({ timeout: 10000 });
  });

  test("should display the MCP page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Welcome to Nango" })).toBeVisible();
  });
});
