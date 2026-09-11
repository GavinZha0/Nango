import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("Skills Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    // /skills is a panel-redirect page — center shows WelcomePage
    await gotoSettled(page, "/skills", page.getByRole("heading", { name: "Welcome to Nango" }));
  });

  editorTest("should display the skills page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Welcome to Nango" })).toBeVisible();
  });
});
