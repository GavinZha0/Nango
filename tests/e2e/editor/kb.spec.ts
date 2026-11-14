import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { uniqueName } from "../helpers/data";

editorTest.describe("Knowledge Base", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(
      page,
      "/kb",
      page.getByRole("button", { name: "New knowledge" }),
    );
  });

  editorTest("should display Knowledge Base panel controls", async ({ page }) => {
    await expect(page.getByText("Knowledge", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New knowledge" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import knowledge folder" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh knowledge bases" })).toBeVisible();
  });

  editorTest("should create a collection, add a page in a folder, enforce description before enabling, and delete", async ({ page }) => {
    const kbSlug = uniqueName("e2e-kb").toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // 1. Create collection without description
    await page.getByRole("button", { name: "New knowledge" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "New knowledge" })).toBeVisible();

    await page.locator("#kb-create-name").fill(kbSlug);
    const createPromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/kb") && r.request().method() === "POST",
      { timeout: 10_000 },
    );
    await dialog.getByRole("button", { name: "Create" }).click();
    const createRes = await createPromise;
    expect(createRes.status()).toBe(201);

    await page.waitForURL(/\/kb\/[0-9a-f-]+/);
    await expect(page.getByRole("heading", { name: new RegExp(kbSlug) })).toBeVisible();

    // Left panel shows the new collection with the no-description hint
    await expect(page.getByText(kbSlug, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("No description — add one to enable this KB.").first()).toBeVisible();

    // 2. Create a page inside a folder in KbEditor
    await page.getByRole("button", { name: "New page" }).click();
    const pageDialog = page.getByRole("dialog");
    await expect(pageDialog).toBeVisible();
    await page.locator("#kb-page-path").fill("guides/getting-started.md");
    await pageDialog.getByRole("button", { name: "Continue" }).click();
    await expect(pageDialog).not.toBeVisible();

    // Fill description + body and save
    await page.locator("#kb-field-description").fill("E2E getting started guide");
    await page.locator("#kb-field-content").fill("# Getting Started\n\nHello Knowledge Base.");
    const savePagePromise = page.waitForResponse(
      (r) => r.url().includes("/pages") && r.request().method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: "Save" }).click();
    const savePageRes = await savePagePromise;
    expect(savePageRes.ok()).toBeTruthy();

    // Reload and verify folder + page persisted
    await page.reload();
    await expect(page.getByText("guides", { exact: true })).toBeVisible();
    await expect(page.getByText("getting-started.md", { exact: true })).toBeVisible();

    // 3. Enabling without description is refused (button stays "Enable KB")
    const enableBtn = page.getByRole("button", { name: "Enable KB" }).first();
    const enableAttempt = page.waitForResponse(
      (r) => r.url().includes("/api/kb/") && r.request().method() === "PATCH",
      { timeout: 10_000 },
    );
    await enableBtn.click();
    const enableAttemptRes = await enableAttempt;
    expect(enableAttemptRes.status()).toBe(400);
    await expect(page.getByRole("button", { name: "Enable KB" }).first()).toBeVisible();

    // 4. Add collection description via Edit dialog, then enable KB
    await page.getByRole("button", { name: `Edit ${kbSlug}` }).last().click();
    const editDialog = page.getByRole("dialog");
    await expect(editDialog).toBeVisible();
    await page.locator("#kb-create-description").fill("E2E test knowledge collection.");
    const updateDescPromise = page.waitForResponse(
      (r) => r.url().includes("/api/kb/") && r.request().method() === "PATCH",
      { timeout: 10_000 },
    );
    await editDialog.getByRole("button", { name: "Save" }).click();
    const updateDescRes = await updateDescPromise;
    expect(updateDescRes.ok()).toBeTruthy();
    await expect(editDialog).not.toBeVisible();

    const enableAfterDesc = page.waitForResponse(
      (r) => r.url().includes("/api/kb/") && r.request().method() === "PATCH",
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: "Enable KB" }).first().click();
    const enableOkRes = await enableAfterDesc;
    expect(enableOkRes.ok()).toBeTruthy();
    await expect(page.getByRole("button", { name: "Disable KB" }).first()).toBeVisible();

    // 5. Delete collection from KbEditor header
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const alertDialog = page.getByRole("alertdialog");
    await expect(alertDialog).toBeVisible();

    const deletePromise = page.waitForResponse(
      (r) => r.url().includes("/api/kb/") && r.request().method() === "DELETE",
      { timeout: 10_000 },
    );
    await alertDialog.getByRole("button", { name: "Delete" }).click();
    const deleteRes = await deletePromise;
    expect(deleteRes.ok()).toBeTruthy();

    await page.waitForURL(/\/kb$/);
    await expect(page.getByText(kbSlug, { exact: true })).not.toBeVisible();
  });
});
