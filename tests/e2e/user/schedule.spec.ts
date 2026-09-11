import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";

userTest.describe("Schedule Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/schedule", page.getByRole("heading", { name: "Schedules" }));
  });

  userTest("should display the schedules heading", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  });
});
