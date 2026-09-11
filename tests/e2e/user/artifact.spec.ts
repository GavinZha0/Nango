import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";

userTest.describe("Artifact Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/artifact", page.getByText("Artifacts", { exact: true }).first());
  });

  userTest("should display the artifacts heading", async ({ page }) => {
    await expect(page.getByText("Artifacts", { exact: true }).first()).toBeVisible();
  });
});
