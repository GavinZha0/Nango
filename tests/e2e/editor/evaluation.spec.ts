import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/editor.json" });

test.describe("Evaluation Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/evaluation");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    await expect(page.getByRole("button", { name: "Evaluation" }).first()).toBeVisible({ timeout: 10000 });
  });

  test("should display the evaluation page", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Evaluation" }).first()).toBeVisible();
  });
});
