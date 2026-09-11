import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";

userTest.describe("Schedule Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/schedule", page.getByText("Schedules", { exact: true }).first());
  });

  userTest("should display the schedules heading", async ({ page }) => {
    await expect(page.getByText("Schedules", { exact: true }).first()).toBeVisible();
  });
});
