import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/editor.json" });

test.describe("Verification Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/verification");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    await expect(page.getByText(/verification/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("should display the verification page", async ({ page }) => {
    await expect(page.getByText(/verification/i).first()).toBeVisible();
  });
});
