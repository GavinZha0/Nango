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
    await expect(page.getByRole("button", { name: "Users" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Login Events" })).toBeVisible();
  });

  test("should switch to Login Events tab and show table headers", async ({ page }) => {
    await page.getByRole("button", { name: "Login Events" }).click();

    // Verify table headers appear
    await expect(page.getByRole("columnheader", { name: "Time" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("columnheader", { name: "User" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Event" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "IP" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "User Agent" })).toBeVisible();
  });
});
