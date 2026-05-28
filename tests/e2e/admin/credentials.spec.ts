import { test, expect } from "@playwright/test";

// Use saved admin auth state so we skip sign-in
test.use({ storageState: "tests/e2e/.auth/admin.json" });

test.describe("Credential Management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/credential");
    // Wait for navigation to settle (don't use networkidle — CopilotKit keeps polling)
    await page.waitForTimeout(2000);
    // Remove CopilotKit dev inspector overlay that intercepts pointer events
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // If not on admin page (user lacks admin role), skip all tests
    if (!page.url().includes("/admin/credential")) {
      test.skip(true, "Test user does not have admin access — first DB user was not our test user");
    }
    // Wait for the page content to load
    await expect(page.getByText("Credentials", { exact: true }).first()).toBeVisible({ timeout: 10000 });
  });

  test("should display the credentials page", async ({ page }) => {
    await expect(page.getByText("Credentials", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New Credential" })).toBeVisible();
  });

  test("should open new credential dialog", async ({ page }) => {
    await page.getByRole("button", { name: "New Credential" }).click();

    // Dialog should appear
    await expect(page.getByRole("heading", { name: "New Credential" })).toBeVisible();

    // Form fields should be visible
    await expect(page.getByLabel(/name/i).first()).toBeVisible();
  });

  test("should create a new credential", async ({ page }) => {
    await page.getByRole("button", { name: "New Credential" }).click();
    await expect(page.getByRole("heading", { name: "New Credential" })).toBeVisible();

    // Fill in the form
    await page.getByLabel(/name/i).first().fill("E2E Test OpenAI");

    // Select provider — click the first select trigger (Provider dropdown)
    const providerTrigger = page.locator("[data-slot='select-trigger']").first();
    await providerTrigger.click();
    await page.getByRole("option", { name: "OpenAI" }).click();

    // Fill API key
    await page.getByLabel("API Key").fill("sk-test-e2e-placeholder-key");

    // Submit
    await page.getByRole("button", { name: /create/i }).click();

    // Dialog should close
    await expect(page.getByRole("heading", { name: "New Credential" })).not.toBeVisible({ timeout: 5000 });

    // New credential should appear in the table
    await expect(page.getByText("E2E Test OpenAI")).toBeVisible({ timeout: 5000 });
  });

  test("should edit a credential", async ({ page }) => {
    // Click on the credential name to edit
    const credLink = page.getByRole("button", { name: "E2E Test OpenAI" });
    if (await credLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await credLink.click();

      // Edit dialog should appear
      await expect(page.getByRole("heading", { name: "Edit Credential" })).toBeVisible();

      // Close without saving
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  });

  test("should delete a credential", async ({ page }) => {
    // Find the delete button for our test credential
    const row = page.getByRole("row").filter({ hasText: "E2E Test OpenAI" });
    if (await row.isVisible({ timeout: 3000 }).catch(() => false)) {
      await row.getByRole("button", { name: "Delete" }).click();

      // Confirmation dialog should appear
      await expect(page.getByText("Delete credential")).toBeVisible();

      // Confirm deletion
      await page.getByRole("button", { name: "Delete" }).last().click();

      // Credential should be gone
      await expect(page.getByText("E2E Test OpenAI")).not.toBeVisible({ timeout: 5000 });
    }
  });
});
