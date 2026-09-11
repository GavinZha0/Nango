import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";

userTest.describe("Notifications Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/notifications", page.getByRole("heading", { name: "Notifications" }));
  });

  userTest("should display the notifications heading", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  });
});
