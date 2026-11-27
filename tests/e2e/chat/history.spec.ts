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
        pinned: false,
      },
      {
        session_id: "thread-e2e-002",
        session_name: "Code Review Notes",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pinned: false,
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

  adminTest("should support pinning, renaming, and Last 30 days grouping via backend API", async ({ page }) => {
    const now = new Date();
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 86_400_000).toISOString();
    const mockSessions = [
      {
        session_id: "thread-e2e-010",
        session_name: "Monthly Retro",
        created_at: fifteenDaysAgo,
        updated_at: fifteenDaysAgo,
        pinned: false,
        pinned_at: null,
        custom_title: null,
      },
    ];

    await page.route("**/api/threads?*", async (route) => {
      await route.fulfill({ status: 200, json: mockSessions });
    });

    await page.route("**/api/threads/thread-e2e-010", async (route) => {
      const body = route.request().postDataJSON() as { pinned?: boolean; title?: string | null };
      if (body.pinned !== undefined) {
        await route.fulfill({
          status: 200,
          json: {
            session_id: "thread-e2e-010",
            session_name: "Monthly Retro",
            pinned: body.pinned,
            pinned_at: body.pinned ? new Date().toISOString() : null,
            custom_title: null,
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          session_id: "thread-e2e-010",
          session_name: body.title || "Monthly Retro",
          pinned: true,
          pinned_at: new Date().toISOString(),
          custom_title: body.title,
        },
      });
    });

    await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));
    await page.getByTestId("right-tab-history").click();

    await expect(page.getByTestId("history-group-last30days")).toBeVisible();
    const item = page.locator('[data-testid="history-session-item"][data-session-id="thread-e2e-010"]');
    // Last 30 days starts collapsed by default
    await expect(item).toBeHidden();
    await page.getByTestId("history-group-toggle-last30days").click();
    await expect(item).toBeVisible();

    // Pin via PATCH
    await item.hover();
    const [pinReq] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/api/threads/thread-e2e-010") && req.method() === "PATCH"),
      item.locator('[data-action="pin"]').click(),
    ]);
    expect(pinReq.postDataJSON()).toEqual({ pinned: true });
    await expect(page.getByTestId("history-group-pinned")).toBeVisible();

    // Rename via dialog + PATCH
    await item.hover();
    await item.locator('[data-action="rename"]').click();
    const input = page.getByTestId("rename-session-input");
    await expect(input).toBeVisible();
    await input.fill("Renamed Retro");
    const [renameReq] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/api/threads/thread-e2e-010") && req.method() === "PATCH"),
      page.getByTestId("rename-session-submit").click(),
    ]);
    expect(renameReq.postDataJSON()).toEqual({ title: "Renamed Retro" });
    await expect(item).toContainText("Renamed Retro");
  });
});
