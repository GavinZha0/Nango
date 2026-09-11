import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";

adminTest.describe("User Management", () => {
  adminTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/admin/user", page.getByRole("heading", { name: "Users" }), {
      accessPath: "/admin/user",
    });
  });

  adminTest("should display the users page with tabs", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    // Tab button renamed from "Users" to avoid a strict-mode clash with the sidebar tooltip.
    await expect(page.getByRole("button", { name: "User Accounts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Login Events" })).toBeVisible();
  });

  adminTest("should switch to Login Events tab and show table headers", async ({ page }) => {
    await page.getByRole("button", { name: "Login Events" }).click();

    await expect(page.getByRole("columnheader", { name: "Time" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("columnheader", { name: "User" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Event" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "IP" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Client" })).toBeVisible();
  });

  adminTest("should display sortable user table headers and allow clicking to toggle sort", async ({ page }) => {
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
