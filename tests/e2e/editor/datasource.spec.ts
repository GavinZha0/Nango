import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/editor.json" });

test.describe("Datasource Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/datasource");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    await expect(page.getByText(/data\s?source/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("should display the datasource page", async ({ page }) => {
    await expect(page.getByText(/data\s?source/i).first()).toBeVisible();
  });
});
