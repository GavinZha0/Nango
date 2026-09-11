import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";

userTest.describe("Artifact Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/artifact", page.getByRole("heading", { name: "Artifacts" }));
  });

  userTest("should display the artifacts heading", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Artifacts" })).toBeVisible();
  });
});
