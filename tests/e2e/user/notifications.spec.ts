import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/user.json" });

test.describe("Notifications Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/notifications");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // The page heading "Notifications" should be visible
    await expect(
      page.getByRole("heading", { name: "Notifications" }),
    ).toBeVisible({ timeout: 10000 });
  });

  test("should display the notifications heading", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Notifications" }),
    ).toBeVisible();
  });
});
