import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("SSH Server Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/ssh-server", page.getByText(/ssh/i).first());
  });

  editorTest("should display the SSH server page", async ({ page }) => {
    await expect(page.getByText(/ssh/i).first()).toBeVisible();
  });
});
