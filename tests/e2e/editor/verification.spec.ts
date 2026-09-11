import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("Verification Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/verification", page.getByRole("button", { name: "Verification" }).first());
  });

  editorTest("should display the verification page", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Verification" }).first()).toBeVisible();
  });
});
