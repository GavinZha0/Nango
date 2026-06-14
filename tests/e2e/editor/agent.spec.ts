import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/editor.json" });

test.describe("Agent Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/agent");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    await expect(page.getByText(/agents/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("should display the agents page", async ({ page }) => {
    await expect(page.getByText(/agents/i).first()).toBeVisible();
  });
});
