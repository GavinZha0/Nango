import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";

editorTest.describe("SSH Server Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/ssh-server", page.getByRole("heading", { name: "SSH Hosts" }));
  });

  editorTest("should display the SSH server page", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "SSH Hosts" })).toBeVisible();
  });
});
