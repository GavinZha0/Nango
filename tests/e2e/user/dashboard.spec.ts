import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";

userTest.describe("Dashboard Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/dashboard", page.getByRole("heading", { name: /Welcome to Nango/i }));
  });

  userTest("should display the dashboard page with welcome content", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /Welcome to Nango/i })).toBeVisible();
  });

  userTest("should display the left toolbar", async ({ page }) => {
    await expect(page.locator('[data-panel="dashboard"]')).toBeVisible();
  });
});
