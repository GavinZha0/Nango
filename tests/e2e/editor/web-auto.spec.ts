import { expect, type Page } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { panelRow } from "../helpers/panels";
import { BASE_NAMES } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

async function ensureTargetExpanded(page: Page, targetName: string) {
  const targetGroup = page.getByTestId("target-group").filter({ hasText: targetName });
  await expect(targetGroup).toBeVisible();
  const chevron = targetGroup.locator("svg.lucide-chevron-right");
  if (await chevron.isVisible().catch(() => false)) {
    await targetGroup.locator('[data-action="toggle-expand"]').click();
  }
}

editorTest.describe("Web Auto Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/web-auto", page.getByText("Web Automation"));
  });

  // 1. Panel display, target folder grouping, and seeded Base Suite verification
  editorTest(
    "should display web auto panel, target groups, and seeded base suite",
    async ({ page }) => {
      // Header controls
      await expect(page.getByTestId("new-suite-button")).toBeVisible();
      await expect(page.getByTestId("refresh-suites-button")).toBeVisible();

      // Target group node for Base-WebAuto-Target
      await ensureTargetExpanded(page, BASE_NAMES.webAutoTarget);

      // Seeded Base Web Auto Suite row
      const baseRow = panelRow(page, BASE_NAMES.webAutoSuite);
      await expect(baseRow).toBeVisible();
      await expect(baseRow).toHaveAttribute("data-name", BASE_NAMES.webAutoSuite);
      await expect(baseRow).toHaveAttribute("data-enabled", "true");

      // Case count badge shows 1 case
      await expect(baseRow.getByTitle("1 case")).toBeVisible();

      // Actions visible on row
      await expect(baseRow.locator('[data-action="run-suite"]')).toBeVisible();
      await expect(baseRow.locator('[data-action="edit-suite"]')).toBeVisible();
      await expect(baseRow.locator('[data-action="delete-suite"]')).toBeVisible();
    },
  );

  // 2. Read-only inspection of Base Suite and Base Case in Editor
  editorTest(
    "should navigate to editor and inspect base web auto suite and case details",
    async ({ page }) => {
      await ensureTargetExpanded(page, BASE_NAMES.webAutoTarget);
      const baseRow = panelRow(page, BASE_NAMES.webAutoSuite);
      await baseRow.click();

      // URL points to /web-auto/<id>
      await page.waitForURL(/\/web-auto\/[0-9a-f-]+/);
      await expect(page.getByTestId("web-auto-suite-heading")).toHaveText(
        BASE_NAMES.webAutoSuite,
      );
      await expect(page.getByTestId("web-auto-back-button")).toBeVisible();

      // Left case list contains the seeded base case
      const baseCaseRow = page.getByTestId("case-row").filter({ hasText: BASE_NAMES.webAutoCase });
      await expect(baseCaseRow).toBeVisible();
      await baseCaseRow.locator('[data-action="select-case"]').click();

      // Script editor tab contains seeded script content
      await expect(page.getByTestId("script-tab")).toBeVisible();
      const scriptTextarea = page.getByTestId("web-auto-script-textarea");
      await expect(scriptTextarea).toBeVisible();
      await expect(scriptTextarea).toHaveValue(/https:\/\/example\.com/);

      // Save button is disabled when not dirty
      await expect(page.getByTestId("save-case-button")).toBeDisabled();

      // Navigate back to web auto panel
      await page.getByTestId("web-auto-back-button").click();
      await page.waitForURL(/\/web-auto$/);
      await ensureTargetExpanded(page, BASE_NAMES.webAutoTarget);
      await expect(panelRow(page, BASE_NAMES.webAutoSuite)).toBeVisible();
    },
  );

  // 3. Ephemeral write flow: create suite & target, create case, edit script, delete case, and delete suite
  // CONTRACT: "只读基底 + 写操作自建自销毁" — base targets and suites are never modified.
  editorTest(
    "should create, inspect, edit case script, and delete an ephemeral suite and target",
    async ({ page }) => {
      const targetName = uniqueName("ephemeral-target");
      const suiteName = uniqueName("ephemeral-suite");
      const caseName = "010_test_auto_script";

      // 1. Open create suite dialog
      await page.getByTestId("new-suite-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // 2. Select "+ Create new target..." and fill target & suite names
      await page.getByTestId("web-auto-target-select").click();
      await page.getByRole("option", { name: "+ Create new target..." }).click();
      await page.getByTestId("web-auto-new-target-name-input").fill(targetName);
      await page.getByTestId("web-auto-name-input").fill(suiteName);

      // 3. Save suite and assert 201 Created
      const saveSuitePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/web-auto-suites") &&
          res.request().method() === "POST" &&
          res.request().postDataJSON()?.parentId !== null,
      );
      await page.getByTestId("save-web-auto-suite-button").click();
      const saveSuiteResp = await saveSuitePromise;
      expect(saveSuiteResp.status()).toBe(201);
      await expect(page.getByRole("dialog")).toBeHidden();

      // 4. Lands on /web-auto/<id>, suite heading matches
      await page.waitForURL(/\/web-auto\/[0-9a-f-]+/);
      await expect(page.getByTestId("web-auto-suite-heading")).toHaveText(suiteName);
      await expect(page.getByText("No cases yet")).toBeVisible();

      // 5. Open create case dialog
      await page.getByTestId("new-case-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // 6. Fill case name
      await page.getByTestId("web-auto-case-name-input").fill(caseName);

      // 7. Save case and assert 201 Created
      const saveCasePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/cases") &&
          res.request().method() === "POST",
      );
      await page.getByTestId("save-web-auto-case-dialog-button").click();
      const saveCaseResp = await saveCasePromise;
      expect(saveCaseResp.status()).toBe(201);
      await expect(page.getByRole("dialog")).toBeHidden();

      // 8. Case appears in list and is active
      const newCaseRow = page.getByTestId("case-row").filter({ hasText: caseName });
      await expect(newCaseRow).toBeVisible();
      await newCaseRow.locator('[data-action="select-case"]').click();

      // 9. Edit script content and save
      const scriptTextarea = page.getByTestId("web-auto-script-textarea");
      await expect(scriptTextarea).toBeVisible();
      await scriptTextarea.fill("async (page) => { return { ephemeral: true }; }");
      await expect(page.getByTestId("save-case-button")).toBeEnabled();

      // Dismiss any toasts that might overlay buttons
      const toastCloseButtons = page.locator('[data-sonner-toast] [data-close-button]');
      const toastCount = await toastCloseButtons.count();
      for (let i = 0; i < toastCount; i++) {
        await toastCloseButtons.nth(i).click().catch(() => {});
      }

      const patchPromise = page.waitForResponse(
        (res) => res.url().includes("/api/web-auto-cases/") && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-case-button").dispatchEvent("click");
      const patchResp = await patchPromise;
      expect(patchResp.ok()).toBeTruthy();
      await expect(page.getByTestId("save-case-button")).toBeDisabled();

      // 10. Delete case via row action
      await newCaseRow.locator('[data-action="delete-case"]').click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      const deleteCasePromise = page.waitForResponse(
        (res) => res.url().includes("/api/web-auto-cases/") && res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-case-button").click();
      const delCaseResp = await deleteCasePromise;
      expect(delCaseResp.ok()).toBeTruthy();
      await expect(page.getByText("No cases yet")).toBeVisible();

      // 11. Navigate back to panel
      await page.getByTestId("web-auto-back-button").click();
      await page.waitForURL(/\/web-auto$/);

      // 12. Expand target and verify suite row
      await ensureTargetExpanded(page, targetName);
      const ephemeralSuiteRow = panelRow(page, suiteName);
      await expect(ephemeralSuiteRow).toBeVisible();

      // 13. Delete ephemeral target (which cascade-deletes the target group and child suite)
      const targetGroup = page.getByTestId("target-group").filter({ hasText: targetName });
      await targetGroup.locator('[data-action="delete-target"]').click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      const deleteTargetPromise = page.waitForResponse(
        (res) => res.url().includes("/api/web-auto-suites/") && res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-button").click();
      const delTargetResp = await deleteTargetPromise;
      expect(delTargetResp.ok()).toBeTruthy();

      // 14. Target and Suite are completely removed
      await expect(page.getByTestId("target-group").filter({ hasText: targetName })).not.toBeVisible();
      await expect(panelRow(page, suiteName)).not.toBeVisible();
    },
  );
});
