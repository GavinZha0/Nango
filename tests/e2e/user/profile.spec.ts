import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/user.json" });

test.describe("Profile Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/profile");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // The page heading "Profile" should be visible
    await expect(
      page.getByRole("heading", { name: "Profile" }),
    ).toBeVisible({ timeout: 10000 });
  });

  test("should display the profile heading", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Profile" }),
    ).toBeVisible();
  });

  test("should display the Basic Info card", async ({ page }) => {
    await expect(
      page.getByText("Basic Info", { exact: true }),
    ).toBeVisible();
  });

  test("should display the Password card", async ({ page }) => {
    await expect(
      page.getByText("Password", { exact: true }).first(),
    ).toBeVisible();
  });

  test("should display the Resource usage section", async ({ page }) => {
    await expect(
      page.getByText("Resource usage", { exact: false }),
    ).toBeVisible();
  });
});
