import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";
import { uniqueName } from "../helpers/data";
import { deleteRowByName } from "../helpers/registry";

adminTest.describe("Credential Management", () => {
  adminTest.beforeEach(async ({ page }) => {
    await gotoSettled(
      page,
      "/admin/credential",
      page.getByText("Credentials", { exact: true }).first(),
      { accessPath: "/admin/credential" },
    );
  });

  adminTest("should display the credentials page", async ({ page }) => {
    await expect(page.getByText("Credentials", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New Credential" })).toBeVisible();
  });

  adminTest("should open new credential dialog", async ({ page }) => {
    await page.getByRole("button", { name: "New Credential" }).click();

    // Dialog should appear
    await expect(page.getByRole("heading", { name: "New Credential" })).toBeVisible();

    // Form fields should be visible
    await expect(page.getByLabel(/name/i).first()).toBeVisible();
  });

  adminTest("should create a new credential", async ({ page }) => {
    const name = uniqueName("Credential");

    await page.getByRole("button", { name: "New Credential" }).click();

    // Scope every locator to the dialog — the toolbar has a same-named
    // "New Credential" button, and the page footer / other places may
    // expose buttons that share text with the form (e.g. "Create").
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "New Credential" })).toBeVisible();

    // Fill in the form (first input labelled "Name").
    await dialog.getByLabel(/name/i).first().fill(name);

    // Provider — picked via the custom ProviderPicker (tabs + button
    // grid), NOT a shadcn Select. See CredentialFormDialog.tsx →
    // ProviderPicker. LLM tab is the default but make it explicit so
    // the test survives a reordering of PROVIDER_TABS.
    await dialog.getByRole("tab", { name: "LLM" }).click();
    await dialog
      .getByRole("tabpanel")
      .getByRole("button", { name: "OpenAI", exact: true })
      .click();

    // Fill API key.
    await dialog.getByLabel("API Key").fill("sk-test-e2e-placeholder-key");

    // Submit. The submit button label is exactly "Create" (or
    // "Creating…" while in flight); anchor on "Create" to avoid
    // matching "Create…".
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    // Dialog should close.
    await expect(page.getByRole("heading", { name: "New Credential" })).not.toBeVisible({ timeout: 5000 });

    // New credential should appear in the table.
    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });

    // Self-clean: the "-e2e-" marker also makes the global teardown
    // sweep a backstop if this run fails midway.
    await deleteRowByName(page, name);
  });

  adminTest("should edit and save a credential", async ({ page }) => {
    const name = uniqueName("Credential");
    const updatedName = uniqueName("CredEdit");
    await createCredential(page, name);

    // Open edit dialog using the precise accessible name
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit Credential" })).toBeVisible();

    // Modify fields: Name and Base URL
    await dialog.getByLabel(/name/i).first().fill(updatedName);
    await dialog.getByLabel(/base url/i).fill("https://api.example.com/v1");

    // Capture PATCH response so server-side validation issues surface immediately
    const patchRespPromise = page.waitForResponse(
      (r) => r.url().includes("/api/admin/credentials/") && r.request().method() === "PATCH",
      { timeout: 15_000 },
    );
    await dialog.getByTestId("credential-submit-btn").click();
    const patchResp = await patchRespPromise;
    expect(patchResp.status(), await patchResp.text()).toBeLessThan(400);

    // Dialog should close; updated name should appear in the table and old name should disappear
    await expect(dialog.getByRole("heading", { name: "Edit Credential" })).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(updatedName)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(name)).not.toBeVisible({ timeout: 5000 });

    // Verify persistence: re-open the dialog and assert that saved fields reflect the new values
    await page.getByRole("button", { name: `Edit ${updatedName}` }).click();
    await expect(dialog.getByRole("heading", { name: "Edit Credential" })).toBeVisible();
    await expect(dialog.getByLabel(/name/i).first()).toHaveValue(updatedName);
    await expect(dialog.getByLabel(/base url/i)).toHaveValue("https://api.example.com/v1");

    // Close dialog and clean up
    await dialog.getByTestId("credential-cancel-btn").click();
    await expect(dialog.getByRole("heading", { name: "Edit Credential" })).not.toBeVisible();
    await deleteRowByName(page, updatedName);
  });

  adminTest("should delete a credential", async ({ page }) => {
    const name = uniqueName("Credential");
    await createCredential(page, name);

    // Find the delete button for our test credential
    const row = page.getByRole("row").filter({ hasText: name });
    await row.getByRole("button", { name: "Delete" }).click();

    // Confirmation alertdialog should appear (heading, not text — the
    // description paragraph also contains "Delete credential").
    await expect(page.getByRole("heading", { name: "Delete credential" })).toBeVisible();

    // Confirm deletion (the confirm Delete vs the row Delete share the label)
    await page
      .getByRole("alertdialog", { name: /delete credential/i })
      .getByRole("button", { name: "Delete", exact: true })
      .click();

    // Wait for dialog to close
    await expect(page.getByRole("heading", { name: "Delete credential" })).not.toBeVisible({ timeout: 10000 });

    // Credential should be gone from the table
    await expect(page.getByText(name)).not.toBeVisible({ timeout: 10000 });
  });

  adminTest("should display sortable credential table headers and toggle sort direction on click", async ({ page }) => {
    const nameHeader = page.getByRole("columnheader", { name: "Name" });
    const providerHeader = page.getByRole("columnheader", { name: "Provider" });
    const serviceHeader = page.getByRole("columnheader", { name: "Service" });

    await expect(nameHeader).toBeVisible();
    await expect(providerHeader).toBeVisible();
    await expect(serviceHeader).toBeVisible();

    // Default sort is Name ascending
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");

    // Clicking Name toggles to descending
    await nameHeader.click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");

    // Clicking Provider switches sort to Provider ascending
    await providerHeader.click();
    await expect(providerHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(nameHeader).toHaveAttribute("aria-sort", "none");
  });
});

/**
 * Create a credential through the UI and wait for it to appear in the
 * table. Shared by the edit/delete cases so each is order-independent.
 */
async function createCredential(page: import("@playwright/test").Page, name: string) {
  await page.getByRole("button", { name: "New Credential" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New Credential" })).toBeVisible();
  await dialog.getByLabel(/name/i).first().fill(name);
  await dialog.getByRole("tab", { name: "LLM" }).click();
  await dialog
    .getByRole("tabpanel")
    .getByRole("button", { name: "OpenAI", exact: true })
    .click();
  await dialog.getByLabel("API Key").fill("sk-test-e2e-placeholder-key");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New Credential" })).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
}
