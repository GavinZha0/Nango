import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { userTest } from "../helpers/fixtures";
import { BASE_NAMES } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

userTest.describe("Schedule Page", () => {
  userTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/schedule", page.getByRole("heading", { name: "Schedules" }));
  });

  userTest("should display schedules panel and list the seeded base schedule", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New schedule" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh schedules" })).toBeVisible();

    const baseRow = page.locator(`[data-testid="schedule-row"][data-name="${BASE_NAMES.dailySchedule}"]`);
    await expect(baseRow).toBeVisible();
    await expect(baseRow).toContainText("every 1 day");

    const toggleBtn = baseRow.locator('[data-action="toggle-enabled"]');
    await expect(toggleBtn).toBeVisible();
    await expect(toggleBtn).toHaveAttribute(
      "aria-label",
      `Enable schedule ${BASE_NAMES.dailySchedule}`,
    );
  });

  userTest("should navigate to editor and inspect base schedule details", async ({ page }) => {
    const baseRow = page.locator(`[data-testid="schedule-row"][data-name="${BASE_NAMES.dailySchedule}"]`);
    await baseRow.getByRole("button", { name: `Open ${BASE_NAMES.dailySchedule}` }).click();

    await page.waitForURL(/\/schedule\/[0-9a-f-]+/);
    await expect(page.getByRole("heading", { name: "Edit schedule" })).toBeVisible();

    // Verify form fields reflect the seeded base schedule
    await expect(page.getByLabel("Name")).toHaveValue(BASE_NAMES.dailySchedule);
    await expect(page.getByLabel("Task")).toHaveValue("Summarize daily workspace activities");
    await expect(page.getByLabel("Every")).toHaveValue("1");

    // Navigate back to schedule panel via header back button
    await page.getByTestId("schedule-back-button").click();
    await page.waitForURL(/\/schedule$/);
    await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  });

  userTest("should create and delete an ephemeral test schedule without modifying base schedule", async ({ page }) => {
    const ephemeralName = uniqueName("Ephemeral-Schedule");

    // 1. Navigate to create new schedule
    await page.getByRole("button", { name: "New schedule" }).click();
    await page.waitForURL(/\/schedule\/new/);
    await expect(page.getByRole("heading", { name: "New schedule" })).toBeVisible();

    // 2. Fill form
    await page.getByLabel("Name").fill(ephemeralName);

    // Pick agent from select dropdown
    await page.getByTestId("schedule-agent-select").click();
    await page.getByRole("option", { name: new RegExp(BASE_NAMES.generalAgent) }).click();

    await page.getByLabel("Task").fill("Run automated e2e ephemeral test task");

    // Set start time to far future so in-process scheduler does not fire during tests
    await page.getByLabel("Start time").fill("2099-01-01T00:00");

    // 3. Save via header save button
    await page.getByTestId("schedule-save-button").click();
    await page.waitForURL(/\/schedule$/);

    // 4. Verify created row in schedules panel
    const createdRow = page.locator(`[data-testid="schedule-row"][data-name="${ephemeralName}"]`);
    await expect(createdRow).toBeVisible();

    // 5. Delete the created ephemeral schedule to keep environment pristine
    await createdRow.getByRole("button", { name: `Open ${ephemeralName}` }).click();
    await page.waitForURL(/\/schedule\/[0-9a-f-]+/);
    await expect(page.getByRole("heading", { name: "Edit schedule" })).toBeVisible();

    await page.getByTestId("schedule-delete-button").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("schedule-confirm-delete-button").click();

    // 6. Verify returned to /schedule and row is removed
    await page.waitForURL(/\/schedule$/);
    await expect(createdRow).not.toBeVisible();
  });
});
