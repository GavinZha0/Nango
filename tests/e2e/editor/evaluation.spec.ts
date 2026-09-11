import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("Evaluation Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/evaluation", page.getByRole("button", { name: "Evaluation" }).first());
  });

  editorTest("should display the evaluation page", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Evaluation" }).first()).toBeVisible();
  });
});
