import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";

adminTest.describe("Config Management", () => {
  adminTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/admin/config", page.getByRole("heading", { name: "Configuration" }), {
      accessPath: "/admin/config",
    });
  });

  adminTest("should display the config page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible();
  });
});
