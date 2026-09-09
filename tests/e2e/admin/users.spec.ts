import { test, expect } from "@playwright/test";

// Use saved admin auth state so we skip sign-in
test.use({ storageState: "tests/e2e/.auth/admin.json" });

test.describe("User Management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/user");
    // Wait for navigation to settle (don't use networkidle — CopilotKit keeps polling)
    await page.waitForTimeout(2000);
    // Remove CopilotKit dev inspector overlay that intercepts pointer events
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // If not on admin page (user lacks admin role), skip all tests
    if (!page.url().includes("/admin/user")) {
      test.skip(true, "Test user does not have admin access — first DB user was not our test user");
    }
    // Wait for the page content to load
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible({ timeout: 10000 });
  });

  test("should display the users page with tabs", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    // Both tab buttons should be visible
    // Tab button should be visible (renamed from Users to avoid strict mode violation with sidebar tooltip)
    await expect(page.getByRole("button", { name: "User Accounts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Login Events" })).toBeVisible();
  });

  test("should switch to Login Events tab and show table headers", async ({ page }) => {
    await page.getByRole("button", { name: "Login Events" }).click();

    // Verify table headers appear
    await expect(page.getByRole("columnheader", { name: "Time" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("columnheader", { name: "User" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Event" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "IP" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Client" })).toBeVisible();
  });

  test("should display sortable user table headers and allow clicking to toggle sort", async ({ page }) => {
    const nameHeader = page.getByRole("columnheader", { name: "Name" });
    const roleHeader = page.getByRole("columnheader", { name: "Role" });
    const statusHeader = page.getByRole("columnheader", { name: "Status" });

    await expect(nameHeader).toBeVisible();
    await expect(roleHeader).toBeVisible();
    await expect(statusHeader).toBeVisible();

    // Default sort is Name ascending
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");

    // Clicking Name toggles to descending
    await nameHeader.click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");

    // Clicking Role switches sort to Role ascending
    await roleHeader.click();
    await expect(roleHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(nameHeader).toHaveAttribute("aria-sort", "none");
  });
});

