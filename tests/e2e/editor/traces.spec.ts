import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("Trace Management", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/trace", page.getByRole("heading", { name: "Traces", exact: true }), {
      accessPath: "/trace",
    });
  });

  editorTest("should display the traces page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Traces", exact: true })).toBeVisible();
  });
});
