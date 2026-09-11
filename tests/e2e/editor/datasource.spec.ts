import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("Datasource Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/datasource", page.getByText(/data\s?source/i).first());
  });

  editorTest("should display the datasource page", async ({ page }) => {
    await expect(page.getByText(/data\s?source/i).first()).toBeVisible();
  });
});
