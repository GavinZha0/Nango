import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { panelRow, toggleEnabled, toggleVisibility, openNew } from "../helpers/panels";
import { BASE_NAMES } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

editorTest.describe("Agent Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/agent", page.getByRole("button", { name: "New BuiltIn agent" }));
  });

  editorTest("should display the agents panel, tabs, and seeded base agents", async ({ page }) => {
    // Header controls
    await expect(page.getByRole("button", { name: "New BuiltIn agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh agents" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /builtin/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /external/i })).toBeVisible();

    // Base Supervisor Agent (Nango)
    const supervisorRow = panelRow(page, BASE_NAMES.supervisorAgent);
    await expect(supervisorRow).toBeVisible();
    await expect(supervisorRow.locator('[data-role="supervisor"]')).toBeVisible();

    // Base General Agent (role: null, so no role badge)
    const generalRow = panelRow(page, BASE_NAMES.generalAgent);
    await expect(generalRow).toBeVisible();
    await expect(generalRow.locator('[data-role]')).not.toBeVisible();

    // Base Evaluator Agent (Judge)
    const judgeRow = panelRow(page, BASE_NAMES.evaluatorAgent);
    await expect(judgeRow).toBeVisible();
    await expect(judgeRow.locator('[data-role="evaluator"]')).toBeVisible();

    // Switch to External tab and back
    await page.getByRole("tab", { name: /external/i }).click();
    await expect(page.getByRole("tab", { name: /external/i })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /builtin/i }).click();
    await expect(page.getByRole("tab", { name: /builtin/i })).toHaveAttribute("aria-selected", "true");
  });

  editorTest("should inspect base agent details in editor", async ({ page }) => {
    const generalRow = panelRow(page, BASE_NAMES.generalAgent);
    await generalRow.getByRole("button", { name: `Edit ${BASE_NAMES.generalAgent}` }).click();

    await page.waitForURL(/\/agent\/[0-9a-f-]+/);
    await expect(page.getByLabel("Name")).toHaveValue(BASE_NAMES.generalAgent);
    await expect(page.getByLabel("Model ID")).toHaveValue("gpt-4o");

    // Navigate back to agent list
    await page.getByRole("button", { name: "Back to agent list" }).click();
    await page.waitForURL(/\/agent$/);
    await expect(panelRow(page, BASE_NAMES.generalAgent)).toBeVisible();
  });

  // Ephemeral write flow: create a built-in agent end-to-end through the UI,
  // then flip its enable / visibility toggles in the left panel and delete it.
  // CONTRACT: "只读基底 + 写操作自建自销毁" — base agents are never modified.
  editorTest(
    "should create, toggle enabled and visibility, and delete an ephemeral agent",
    async ({ page }) => {
      const agentName = uniqueName("Ephemeral-Agent");

      // ── Create ──
      await openNew(page, "New BuiltIn agent");
      await page.waitForURL(/\/agent\/new/);

      await page.getByLabel("Name").fill(agentName);

      // Select seeded base LLM credential in Provider combobox
      await page.getByRole("combobox", { name: "Provider" }).click();
      const credOption = page.getByRole("option", { name: new RegExp(BASE_NAMES.llmCredential) });
      await credOption.waitFor({ state: "visible", timeout: 10_000 });
      await credOption.click();

      await page.getByLabel("Model ID").fill("gpt-4o");

      const saveRespPromise = page.waitForResponse(
        (r) => r.url().includes("/api/builtin-agents") && r.request().method() === "POST",
        { timeout: 15_000 },
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const saveResp = await saveRespPromise;
      expect(saveResp.status(), await saveResp.text()).toBe(201);

      // Saving navigates back to /agent and the row appears in the list.
      const row = panelRow(page, agentName);
      await expect(row).toBeVisible({ timeout: 10_000 });

      // ── Toggles ──
      await toggleEnabled(row, "agent");
      await toggleEnabled(row, "agent"); // flip back
      await toggleVisibility(row);
      await toggleVisibility(row); // flip back

      // ── Cleanup (self-destruction) ──
      await row.getByRole("button", { name: `Edit ${agentName}` }).click();
      await page.waitForURL(/\/agent\/[0-9a-f-]+/);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Delete agent" })
        .getByRole("button", { name: "Delete", exact: true })
        .click();

      await page.waitForURL(/\/agent$/);
      await expect(row).not.toBeVisible({ timeout: 10_000 });
    },
  );
});

