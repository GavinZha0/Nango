import { test, expect } from "@playwright/test";

// Use saved admin auth state so we skip sign-in
test.use({ storageState: "tests/e2e/.auth/admin.json" });

test.describe("Admin Guardrails Control Plane", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/guardrails");
    // Wait for navigation to settle (avoid networkidle due to CopilotKit SSE/polling)
    await page.waitForTimeout(2000);
    // Remove CopilotKit dev inspector overlay that intercepts pointer events
    await page.evaluate(() => {
      document.querySelectorAll("cpk-web-inspector").forEach((el) => el.remove());
    });
    // If not on admin page (user lacks admin role), skip all tests
    if (!page.url().includes("/admin/guardrails")) {
      test.skip(true, "Test user does not have admin access — first DB user was not our test user");
    }
    // Wait for the page content to load
    await expect(page.getByRole("heading", { name: "Guardrails" })).toBeVisible({ timeout: 10000 });
  });

  test("should display the default Config tab with stats, pipeline visualizer, and registries", async ({ page }) => {
    // 1. Verify Top Header and Tab Switchers (scoped to header bar to avoid sidebar navigation buttons)
    const header = page.locator("div.border-b").filter({ hasText: "Guardrails" }).first();
    await expect(header.getByRole("heading", { name: "Guardrails" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Config", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Audit", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();

    // 2. Verify Stat Overview Metrics in Left Column
    await expect(page.getByText("Level:", { exact: true })).toBeVisible();
    await expect(page.getByText("HIGH", { exact: true })).toBeVisible();
    await expect(page.getByText("Active:", { exact: true })).toBeVisible();
    await expect(page.getByText("24h:", { exact: true })).toBeVisible();

    // 3. Verify Tool Risk Registry Table in Right Column
    await expect(page.getByText("Tool Risk Registry")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add tool" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tool Name" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Risk Level" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Approval" })).toBeVisible();

    // 4. Verify Safety Policies Table in Right Column
    await expect(page.getByText("Safety Policies")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add policy" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Policy Name" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Category" })).toBeVisible();
  });

  test("should switch to Audit tab and display interception logs table with filters", async ({ page }) => {
    const header = page.locator("div.border-b").filter({ hasText: "Guardrails" }).first();

    // 1. Click the Audit tab button
    await header.getByRole("button", { name: "Audit", exact: true }).click();

    // 2. Verify URL query parameter updates to ?tab=logs
    await expect(page).toHaveURL(/.*tab=logs.*/);

    // 3. Verify Search and Table container appear
    await expect(page.getByPlaceholder("Search agent, topic & context...")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("table")).toBeVisible();

    // 4. Verify Audit Table column headers
    await expect(page.getByRole("columnheader", { name: "Time" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Agent" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Stage" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Category" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Action" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Severity" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Context" })).toBeVisible();

    // 5. Switch back to Config tab and verify return to default view
    await header.getByRole("button", { name: "Config", exact: true }).click();
    await expect(page.getByText("Tool Risk Registry")).toBeVisible();
  });
});
