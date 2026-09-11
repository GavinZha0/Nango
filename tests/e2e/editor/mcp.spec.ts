import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("MCP Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    // /mcp is a panel-redirect page — center shows WelcomePage
    await gotoSettled(page, "/mcp", page.getByRole("heading", { name: "Welcome to Nango" }));
  });

  editorTest("should display the MCP page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Welcome to Nango" })).toBeVisible();
  });
});
