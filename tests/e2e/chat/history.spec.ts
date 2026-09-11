import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";

adminTest.describe("History Panel", () => {
  adminTest.beforeEach(async ({ page }) => {
    // Ensure the right panel is open before navigating.
    await page.addInitScript(() => {
      localStorage.setItem(
        "nango:sidebar",
        JSON.stringify({ state: { leftPanelOpen: false, rightPanelOpen: true }, version: 0 }),
      );
    });
  });

  adminTest("should display empty history state when no past conversations exist", async ({ page }) => {
    // Explicitly mock empty session list to guarantee isolation from parallel chat runs
    await page.route("**/api/threads?*", async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });

    await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));

    await page.getByTestId("right-tab-history").click();
    await expect(page.getByTestId("right-tabpanel-history")).toBeVisible();
    await expect(page.getByText("No past conversations.")).toBeVisible();
  });

  adminTest("should display past sessions and allow deleting a specific session without ambiguity", async ({ page }) => {
    const mockSessions = [
      {
        session_id: "thread-e2e-001",
        session_name: "Project Planning Session",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        session_id: "thread-e2e-002",
        session_name: "Code Review Notes",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    // Mock session list
    await page.route("**/api/threads?*", async (route) => {
      await route.fulfill({ status: 200, json: mockSessions });
    });
    // Mock delete endpoint
    await page.route("**/api/threads/thread-e2e-001", async (route) => {
      await route.fulfill({ status: 204 });
    });

    await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));
    await page.getByTestId("right-tab-history").click();

    // Verify both items render cleanly using data-testid and data-session-id
    const item1 = page.locator('[data-testid="history-session-item"][data-session-id="thread-e2e-001"]');
    const item2 = page.locator('[data-testid="history-session-item"][data-session-id="thread-e2e-002"]');
    await expect(item1).toBeVisible();
    await expect(item2).toBeVisible();
    await expect(item1).toContainText("Project Planning Session");
    await expect(item2).toContainText("Code Review Notes");

    // Test specific delete action (disambiguated by data-action and scoped to row)
    await item1.hover();
    const deleteBtn = item1.locator('[data-action="delete"]');
    await expect(deleteBtn).toBeVisible();

    // Verify the real DELETE request is dispatched and row is removed
    const [deleteReq] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/api/threads/thread-e2e-001") && req.method() === "DELETE"),
      deleteBtn.click(),
    ]);
    expect(deleteReq).toBeTruthy();

    // Verify item 1 is removed while item 2 remains
    await expect(item1).toBeHidden();
    await expect(item2).toBeVisible();
  });
});
