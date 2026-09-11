import { expect, type Page } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { panelRow } from "../helpers/panels";
import { BASE_NAMES } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

async function ensureServerExpanded(page: Page, serverName: string) {
  const serverGroup = page.getByTestId("server-group").filter({ hasText: serverName });
  await expect(serverGroup).toBeVisible();
  const chevron = serverGroup.locator("svg.lucide-chevron-right");
  if (await chevron.isVisible().catch(() => false)) {
    await serverGroup.locator('[data-action="toggle-expand"]').click();
  }
}

editorTest.describe("Verification Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/verification", page.getByText("MCP Verification"));
  });

  // 1. Panel display, server grouping, and seeded Base Suite verification
  editorTest(
    "should display the verification panel, server groups, and seeded base suite",
    async ({ page }) => {
      // Header controls
      await expect(page.getByTestId("new-suite-button")).toBeVisible();
      await expect(page.getByTestId("refresh-suites-button")).toBeVisible();

      // Server group node for Base-Mock-e2e-Mcp
      await ensureServerExpanded(page, BASE_NAMES.mcpServer);

      // Seeded Base Verification Suite row
      const baseRow = panelRow(page, BASE_NAMES.verificationSuite);
      await expect(baseRow).toBeVisible();
      await expect(baseRow).toHaveAttribute("data-name", BASE_NAMES.verificationSuite);
      await expect(baseRow).toHaveAttribute("data-visibility", "public");

      // Case count badge shows 1 case
      await expect(baseRow.getByTitle("1 case")).toBeVisible();

      // RBAC for non-author editor on admin-created public row:
      // Can open/view, but cannot delete
      await expect(baseRow.locator('[data-action="open-suite"]')).toBeVisible();
      await expect(baseRow.locator('[data-action="delete-suite"]')).not.toBeVisible();
    },
  );

  // 2. Read-only inspection of Base Suite and Base Case in Editor
  editorTest(
    "should navigate to editor and inspect base suite and case details",
    async ({ page }) => {
      await ensureServerExpanded(page, BASE_NAMES.mcpServer);
      const baseRow = panelRow(page, BASE_NAMES.verificationSuite);
      await baseRow.locator('[data-action="open-suite"]').click();

      // URL points to /verification/<id>
      await page.waitForURL(/\/verification\/[0-9a-f-]+/);
      await expect(page.getByTestId("verification-suite-heading")).toContainText(
        BASE_NAMES.verificationSuite,
      );
      await expect(page.getByTestId("verification-back-button")).toBeVisible();

      // Left case list contains the seeded base case
      const baseCaseRow = page.getByTestId("case-row").filter({ hasText: BASE_NAMES.verificationCase });
      await expect(baseCaseRow).toBeVisible();
      await baseCaseRow.locator('[data-action="select-case"]').click();

      // Inspector heading reflects the selected case
      await expect(page.getByTestId("verification-case-heading")).toHaveText(
        BASE_NAMES.verificationCase,
      );

      // Form values match seeded Base Case
      const inputTextarea = page.getByTestId("case-input-textarea");
      await expect(inputTextarea).toBeVisible();
      expect(await inputTextarea.inputValue()).toContain("hello");

      // Save button is disabled when there are no dirty edits
      await expect(page.getByTestId("save-case-button")).toBeDisabled();

      // Navigate back to verification panel
      await page.getByTestId("verification-back-button").click();
      await page.waitForURL(/\/verification$/);
      await ensureServerExpanded(page, BASE_NAMES.mcpServer);
      await expect(panelRow(page, BASE_NAMES.verificationSuite)).toBeVisible();
    },
  );

  // 3. Ephemeral write flow: create suite, create case, edit, delete case, and delete suite
  // CONTRACT: "只读基底 + 写操作自建自销毁" — base suites and cases are never modified.
  editorTest(
    "should create, inspect, edit case, and delete an ephemeral suite and case",
    async ({ page }) => {
      const suiteName = uniqueName("ephemeral-suite");
      const caseName = "010_test_case";

      // 1. Open create suite dialog
      await page.getByTestId("new-suite-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // 2. Select MCP server and fill suite details
      await page.getByTestId("suite-server-select").click();
      await page.getByRole("option", { name: new RegExp(BASE_NAMES.mcpServer) }).click();
      await page.getByTestId("suite-name-input").fill(suiteName);
      await page.getByTestId("suite-description-input").fill("Ephemeral test suite");

      // 3. Save suite and assert 201 Created
      const saveSuitePromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-suites") && res.request().method() === "POST",
      );
      await page.getByTestId("save-suite-button").click();
      const saveSuiteResp = await saveSuitePromise;
      expect(saveSuiteResp.status()).toBe(201);

      // 4. Lands on /verification/<id>, suite heading matches
      await page.waitForURL(/\/verification\/[0-9a-f-]+/);
      await expect(page.getByTestId("verification-suite-heading")).toHaveText(suiteName);
      await expect(page.getByText("No cases yet")).toBeVisible();

      // 5. Open create case dialog
      await page.getByTestId("new-case-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // 6. Select tool and fill case name
      await page.getByTestId("case-tool-select").click();
      await page.getByRole("option", { name: "echo_tool" }).click();
      await page.getByTestId("case-name-input").fill(caseName);

      // 7. Save case and assert 201 Created
      const saveCasePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/verification-cases") &&
          res.request().method() === "POST",
      );
      await page.getByTestId("save-case-dialog-button").click();
      const saveCaseResp = await saveCasePromise;
      expect(saveCaseResp.status()).toBe(201);

      // 8. Case appears in list and is active
      const newCaseRow = page.getByTestId("case-row").filter({ hasText: caseName });
      await expect(newCaseRow).toBeVisible();
      await expect(page.getByTestId("verification-case-heading")).toHaveText(caseName);

      // 9. Edit input JSON and save
      const inputTextarea = page.getByTestId("case-input-textarea");
      await inputTextarea.fill('{"message": "ephemeral updated"}');
      await expect(page.getByTestId("save-case-button")).toBeEnabled();

      const patchPromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-cases/") && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-case-button").click();
      const patchResp = await patchPromise;
      expect(patchResp.ok()).toBeTruthy();
      await expect(page.getByTestId("save-case-button")).toBeDisabled();

      // 10. Delete case via row action
      await newCaseRow.locator('[data-action="delete-case"]').click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      const deleteCasePromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-cases/") && res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-case-button").click();
      const delCaseResp = await deleteCasePromise;
      expect(delCaseResp.status()).toBe(204);
      await expect(page.getByText("No cases yet")).toBeVisible();

      // 11. Navigate back to panel
      await page.getByTestId("verification-back-button").click();
      await page.waitForURL(/\/verification$/);
      await ensureServerExpanded(page, BASE_NAMES.mcpServer);

      const ephemeralRow = panelRow(page, suiteName);
      await expect(ephemeralRow).toBeVisible();
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");

      // 12. Toggle visibility (author has permission)
      const patchVisPromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-suites/") && res.request().method() === "PATCH",
      );
      await ephemeralRow.locator('[data-action="toggle-visibility"]').click();
      await patchVisPromise;
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "public");

      const patchVis2 = page.waitForResponse(
        (res) => res.url().includes("/api/verification-suites/") && res.request().method() === "PATCH",
      );
      await ephemeralRow.locator('[data-action="toggle-visibility"]').click();
      await patchVis2;
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");

      // 13. Delete suite via panel row action
      await ephemeralRow.locator('[data-action="delete-suite"]').click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      const deleteSuitePromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-suites/") && res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-suite-button").click();
      const delSuiteResp = await deleteSuitePromise;
      expect(delSuiteResp.status()).toBe(204);

      // 14. Suite row is removed
      await expect(panelRow(page, suiteName)).not.toBeVisible();
    },
  );
});
