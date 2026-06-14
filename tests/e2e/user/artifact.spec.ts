import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/user.json" });

test.describe("Artifact Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/artifact");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // The left panel heading "Artifacts" should be visible
    await expect(
      page.getByText("Artifacts", { exact: true }).first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test("should display the artifacts heading", async ({ page }) => {
    await expect(
      page.getByText("Artifacts", { exact: true }).first(),
    ).toBeVisible();
  });
});
