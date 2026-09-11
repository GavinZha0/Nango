import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";

userTest.describe("Profile Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/profile", page.getByRole("heading", { name: "Profile" }));
  });

  userTest("should display the profile heading", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  });

  userTest("should display the Basic Info card", async ({ page }) => {
    await expect(page.getByText("Basic Info", { exact: true })).toBeVisible();
  });

  userTest("should display the Password card", async ({ page }) => {
    await expect(page.getByText("Password", { exact: true }).first()).toBeVisible();
  });

  userTest("should display the Resource usage section", async ({ page }) => {
    await expect(page.getByText("Resource usage", { exact: false })).toBeVisible();
  });
});
