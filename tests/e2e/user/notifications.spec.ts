import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";
import { BASE_NAMES } from "../constants/base-resources";
import { TEST_USERS } from "../constants/test-users";
import { createEphemeralNotification } from "../fixtures/base-seed";

userTest.describe("Notifications Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/notifications", page.getByRole("heading", { name: "Notifications" }));
  });

  userTest("should display notifications page, unread count, and base notifications", async ({ page }) => {
    const heading = page.getByRole("heading", { name: /Notifications/ });
    await expect(heading).toBeVisible();
    await expect(heading).toContainText("1 unread");

    // All filter tabs visible
    await expect(page.getByTestId("filter-all")).toBeVisible();
    await expect(page.getByTestId("filter-unread")).toBeVisible();
    await expect(page.getByTestId("filter-read")).toBeVisible();
    await expect(page.getByTestId("filter-errors")).toBeVisible();

    // Base unread notification
    const unreadRow = page.locator(
      `[data-testid="notification-row"][data-title="${BASE_NAMES.unreadNotification}"]`,
    );
    await expect(unreadRow).toBeVisible();
    await expect(unreadRow).toHaveAttribute("data-unread", "true");
    await expect(unreadRow).toHaveAttribute("data-kind", "run_completed");
    await expect(unreadRow).toContainText("Summarize daily workspace activities");

    // Base read notification
    const readRow = page.locator(
      `[data-testid="notification-row"][data-title="${BASE_NAMES.readNotification}"]`,
    );
    await expect(readRow).toBeVisible();
    await expect(readRow).toHaveAttribute("data-unread", "false");
    await expect(readRow).toHaveAttribute("data-kind", "run_failed");
    await expect(readRow).toContainText("Sync external data sources");
  });

  userTest("should filter notifications by status tab", async ({ page }) => {
    const unreadRow = page.locator(
      `[data-testid="notification-row"][data-title="${BASE_NAMES.unreadNotification}"]`,
    );
    const readRow = page.locator(
      `[data-testid="notification-row"][data-title="${BASE_NAMES.readNotification}"]`,
    );

    // 1. Unread filter
    await page.getByTestId("filter-unread").click();
    await expect(unreadRow).toBeVisible();
    await expect(readRow).not.toBeVisible();

    // 2. Read filter
    await page.getByTestId("filter-read").click();
    await expect(readRow).toBeVisible();
    await expect(unreadRow).not.toBeVisible();

    // 3. Errors filter (the read failure notification has kind: "run_failed")
    await page.getByTestId("filter-errors").click();
    await expect(readRow).toBeVisible();
    await expect(unreadRow).not.toBeVisible();

    // 4. All filter
    await page.getByTestId("filter-all").click();
    await expect(unreadRow).toBeVisible();
    await expect(readRow).toBeVisible();
  });

  userTest("should expand and collapse notification details", async ({ page }) => {
    const unreadRow = page.locator(
      `[data-testid="notification-row"][data-title="${BASE_NAMES.unreadNotification}"]`,
    );
    await expect(unreadRow).toBeVisible();

    // Click to expand
    await unreadRow.click();
    const detail = page.getByTestId("notification-expanded-row");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Summarize daily workspace activities");
    await expect(detail).toContainText("Daily workspace summary completed successfully");

    // Click to collapse
    await unreadRow.click();
    await expect(detail).not.toBeVisible();
  });

  userTest("should open notification bell dropdown and navigate via View all", async ({ page }) => {
    const bellTrigger = page.getByTestId("notification-bell-trigger");
    await expect(bellTrigger).toBeVisible();

    // Open bell dropdown
    await bellTrigger.click();

    // Verify dropdown items
    const bellRow = page.locator('[data-testid="bell-notification-row"]').first();
    await expect(bellRow).toBeVisible();

    // Click "View all" link in footer
    const viewAllLink = page.getByTestId("bell-view-all-link");
    await expect(viewAllLink).toBeVisible();
    await viewAllLink.click();

    await page.waitForURL(/\/notifications$/);
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  });

  userTest("should mark as read and delete an ephemeral notification without modifying base notifications", async ({ page }) => {
    const ephemeralTitle = "Ephemeral-e2e-Notification";
    await createEphemeralNotification(TEST_USERS.regular.email, ephemeralTitle);

    // Refresh page to load the new notification
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();

    const ephemeralRow = page.locator(
      `[data-testid="notification-row"][data-title="${ephemeralTitle}"]`,
    );
    await expect(ephemeralRow).toBeVisible();
    await expect(ephemeralRow).toHaveAttribute("data-unread", "true");

    // 1. Mark as read via row action
    const markReadBtn = ephemeralRow.locator('[data-action="mark-read"]');
    await expect(markReadBtn).toBeVisible();
    await markReadBtn.click();

    // Verify row flips to read
    await expect(ephemeralRow).toHaveAttribute("data-unread", "false");

    // 2. Delete the ephemeral notification
    const deleteBtn = ephemeralRow.locator('[data-action="delete"]');
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    // Verify row removed from table
    await expect(ephemeralRow).not.toBeVisible();
  });
});
