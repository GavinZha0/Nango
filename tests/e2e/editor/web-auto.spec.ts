import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("Web Auto Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    // /web-auto is a panel-redirect page — center shows WelcomePage
    await gotoSettled(page, "/web-auto", page.getByRole("heading", { name: "Welcome to Nango" }));
  });

  editorTest("should display the web auto page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Welcome to Nango" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Web Auto" }).first()).toBeVisible();
  });
});
