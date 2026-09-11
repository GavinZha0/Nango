import { expect, type Page } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { panelRow } from "../helpers/panels";
import { BASE_NAMES } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

async function ensureAgentExpanded(page: Page, agentName: string) {
  const agentGroup = page.getByTestId("agent-group").filter({ hasText: agentName });
  await expect(agentGroup).toBeVisible();
  const chevron = agentGroup.locator("svg.lucide-chevron-right");
  if (await chevron.isVisible().catch(() => false)) {
    await agentGroup.locator('[data-action="toggle-expand"]').click();
  }
}

editorTest.describe("Evaluation Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/evaluation", page.getByText("Builtin"));
  });

  // 1. Panel display, agent grouping, and seeded Base Eval Suite verification
  editorTest(
    "should display evaluation panel, builtin/external tabs, and seeded base suite",
    async ({ page }) => {
      // Header controls & tabs
      await expect(page.getByTestId("eval-tab-builtin")).toBeVisible();
      await expect(page.getByTestId("eval-tab-external")).toBeVisible();
      await expect(page.getByTestId("new-suite-button")).toBeVisible();
      await expect(page.getByTestId("refresh-suites-button")).toBeVisible();

      // Agent group node for Base-General-e2e-Agent
      await ensureAgentExpanded(page, BASE_NAMES.generalAgent);

      // Seeded Base Evaluation Suite row
      const baseRow = panelRow(page, BASE_NAMES.evalSuite);
      await expect(baseRow).toBeVisible();
      await expect(baseRow).toHaveAttribute("data-name", BASE_NAMES.evalSuite);
      await expect(baseRow).toHaveAttribute("data-visibility", "public");

      // Case count badge shows 1 case
      await expect(baseRow.getByTitle("1 case")).toBeVisible();

      // RBAC for non-author editor on admin-created public row:
      // Can open/view, but cannot delete
      await expect(baseRow.locator('[data-action="run-suite"]')).toBeVisible();
      await expect(baseRow.locator('[data-action="delete-suite"]')).not.toBeVisible();
    },
  );

  // 2. Read-only inspection of Base Suite and Base Case in Editor
  editorTest(
    "should navigate to editor and inspect base eval suite and case details",
    async ({ page }) => {
      await ensureAgentExpanded(page, BASE_NAMES.generalAgent);
      const baseRow = panelRow(page, BASE_NAMES.evalSuite);
      await baseRow.click();

      // URL points to /evaluation/<id>
      await page.waitForURL(/\/evaluation\/[0-9a-f-]+/);
      await expect(page.getByTestId("eval-suite-heading")).toContainText(
        BASE_NAMES.evalSuite,
      );
      await expect(page.getByTestId("eval-back-button")).toBeVisible();

      // Left case list contains the seeded base case
      const baseCaseRow = page.getByTestId("case-row").filter({ hasText: BASE_NAMES.evalCase });
      await expect(baseCaseRow).toBeVisible();
      await baseCaseRow.locator('[data-action="select-case"]').click();

      // Inspector heading reflects the selected case
      await expect(page.getByTestId("eval-case-name-heading")).toHaveText(
        BASE_NAMES.evalCase,
      );

      // Form values match seeded Base Case
      const turnTextarea = page.getByTestId("eval-turn-textarea");
      await expect(turnTextarea).toBeVisible();
      expect(await turnTextarea.inputValue()).toContain("Hello, please introduce yourself.");

      // Save button is disabled when not dirty
      await expect(page.getByTestId("save-case-button")).toBeDisabled();

      // Navigate back to evaluation panel
      await page.getByTestId("eval-back-button").click();
      await page.waitForURL(/\/evaluation$/);
      await ensureAgentExpanded(page, BASE_NAMES.generalAgent);
      await expect(panelRow(page, BASE_NAMES.evalSuite)).toBeVisible();
    },
  );

  // 3. Ephemeral write flow: create suite, create case, edit turn, delete case, and delete suite
  // CONTRACT: "只读基底 + 写操作自建自销毁" — base suites and cases are never modified.
  editorTest(
    "should create, inspect, edit case turn, and delete an ephemeral suite and case",
    async ({ page }) => {
      const suiteName = uniqueName("ephemeral-eval-suite");
      const caseName = "010_test_eval_turn";

      // 1. Open create suite dialog
      await page.getByTestId("new-suite-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // 2. Select target agent and fill suite name
      await page.getByTestId("eval-suite-agent-select").click();
      await page.getByRole("option", { name: new RegExp(BASE_NAMES.generalAgent) }).click();
      await page.getByTestId("eval-suite-name-input").fill(suiteName);

      // 3. Save suite and assert 201 Created
      const saveSuitePromise = page.waitForResponse(
        (res) => res.url().includes("/api/eval-suites") && res.request().method() === "POST",
      );
      await page.getByTestId("save-eval-suite-button").click();
      const saveSuiteResp = await saveSuitePromise;
      expect(saveSuiteResp.status()).toBe(201);

      // 4. Lands on /evaluation/<id>, suite heading matches
      await page.waitForURL(/\/evaluation\/[0-9a-f-]+/);
      await expect(page.getByTestId("eval-suite-heading")).toHaveText(suiteName);
      await expect(page.getByText("No cases yet")).toBeVisible();

      // 5. Open create case dialog
      await page.getByTestId("new-case-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // 6. Fill case name
      await page.getByTestId("eval-case-name-input").fill(caseName);

      // 7. Save case and assert 201 Created
      const saveCasePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/cases") &&
          res.request().method() === "POST",
      );
      await page.getByTestId("save-eval-case-dialog-button").click();
      const saveCaseResp = await saveCasePromise;
      expect(saveCaseResp.status()).toBe(201);

      // 8. Case appears in list and is active
      const newCaseRow = page.getByTestId("case-row").filter({ hasText: caseName });
      await expect(newCaseRow).toBeVisible();
      await expect(page.getByTestId("eval-case-name-heading")).toHaveText(caseName);

      // 9. Add conversation turn, edit user message, and save
      await page.getByTestId("add-turn-button").click();
      const turnTextarea = page.getByTestId("eval-turn-textarea");
      await expect(turnTextarea).toBeVisible();
      await turnTextarea.fill("What is the weather today in Tokyo?");
      await expect(page.getByTestId("save-case-button")).toBeEnabled();

      const patchPromise = page.waitForResponse(
        (res) => res.url().includes("/api/eval-cases/") && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-case-button").click();
      const patchResp = await patchPromise;
      expect(patchResp.ok()).toBeTruthy();
      await expect(page.getByTestId("save-case-button")).toBeDisabled();

      // 10. Delete case via row action
      await newCaseRow.locator('[data-action="delete-case"]').click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      const deleteCasePromise = page.waitForResponse(
        (res) => res.url().includes("/api/eval-cases/") && res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-button").click();
      const delCaseResp = await deleteCasePromise;
      expect(delCaseResp.status()).toBe(204);
      await expect(page.getByText("No cases yet")).toBeVisible();

      // 11. Navigate back to panel
      await page.getByTestId("eval-back-button").click();
      await page.waitForURL(/\/evaluation$/);
      await ensureAgentExpanded(page, BASE_NAMES.generalAgent);

      const ephemeralRow = panelRow(page, suiteName);
      await expect(ephemeralRow).toBeVisible();
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");

      // 12. Toggle visibility (author has permission)
      const patchVisPromise = page.waitForResponse(
        (res) => res.url().includes("/api/eval-suites/") && res.request().method() === "PATCH",
      );
      await ephemeralRow.locator('[data-action="toggle-visibility"]').click();
      await patchVisPromise;
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "public");

      const patchVis2 = page.waitForResponse(
        (res) => res.url().includes("/api/eval-suites/") && res.request().method() === "PATCH",
      );
      await ephemeralRow.locator('[data-action="toggle-visibility"]').click();
      await patchVis2;
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");

      // 13. Delete suite via panel row action
      await ephemeralRow.locator('[data-action="delete-suite"]').click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      const deleteSuitePromise = page.waitForResponse(
        (res) => res.url().includes("/api/eval-suites/") && res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-button").click();
      const delSuiteResp = await deleteSuitePromise;
      expect(delSuiteResp.status()).toBe(204);

      // 14. Suite row is removed
      await expect(panelRow(page, suiteName)).not.toBeVisible();
    },
  );
});
