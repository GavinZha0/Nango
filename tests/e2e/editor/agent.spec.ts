import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { uniqueName } from "../helpers/data";
import { panelRow, toggleEnabled, toggleVisibility, openNew } from "../helpers/panels";
import { trackResource } from "../helpers/registry";

// The default 1280x720 viewport squeezes the left panel so the resizable
// separator's hit-area overlaps the "New BuiltIn agent" button (the panel
// header's action buttons sit right against the divider). Wider viewport
// matches how editors actually use the workspace.
editorTest.use({ viewport: { width: 1600, height: 900 } });

editorTest.describe("Agent Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/agent", page.getByText(/agents/i).first());
  });

  editorTest("should display the agents page", async ({ page }) => {
    await expect(page.getByText(/agents/i).first()).toBeVisible();
  });

  // P0 reference flow: create a built-in agent end-to-end through the UI,
  // then flip its enable / visibility toggles in the left panel.
  // Credentials are admin-managed (see docs/rbac.md): the LLM credential is
  // seeded via the admin API in a request context, and /api/tools exposes
  // every enabled LLM credential to editors, so the editor can legitimately
  // pick it in the form. Both rows carry the "-e2e-" marker; the agent is
  // deleted through the UI at the end and the global teardown sweep is
  // the backstop for either row if the run fails midway.
  editorTest(
    "should create an agent, then toggle enabled and visibility",
    async ({ page, playwright }) => {
      const credName = uniqueName("Credential");
      const agentName = uniqueName("Agent");

      const adminApi = await playwright.request.newContext({
        storageState: "tests/e2e/.auth/admin.json",
      });
      const credRes = await adminApi.post("/api/admin/credentials", {
        data: {
          name: credName,
          type: "api_key",
          serviceType: "llm",
          provider: "openai",
          payload: { key: "sk-test-e2e-placeholder-key" },
        },
      });
      expect(credRes.ok()).toBeTruthy();
      trackResource("credential", credName);
      await adminApi.dispose();

      // ── Create ── the panel's "New" button navigates to the editor.
      await openNew(page, "New BuiltIn agent");

      await page.getByLabel("Name").fill(agentName);

      // Provider — the combobox labelled "Provider" lists LLM credentials.
      // The Base UI popup animates in; wait for the listbox options before
      // clicking, otherwise the click lands while the popup is still
      // mounting and the option never resolves.
      await page.getByRole("combobox", { name: "Provider" }).click();
      const credOption = page.getByRole("option", { name: new RegExp(credName) });
      await credOption.waitFor({ state: "visible", timeout: 10_000 });
      await credOption.click();

      await page.getByLabel("Model ID").fill("gpt-4o");

      // Capture the POST response so a rejected save surfaces the API
      // error directly instead of failing later at the row assertion.
      const saveRespPromise = page.waitForResponse(
        (r) => r.url().includes("/api/builtin-agents") && r.request().method() === "POST",
        { timeout: 15_000 },
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const saveResp = await saveRespPromise;
      expect(saveResp.status(), await saveResp.text()).toBeLessThan(400);

      // Saving navigates back to /agent and the row appears in the list.
      const row = panelRow(page, agentName);
      await expect(row).toBeVisible({ timeout: 10_000 });
      trackResource("agent", agentName);

      // ── P0 toggles ── both live on the list row.
      await toggleEnabled(row, "agent");
      await toggleEnabled(row, "agent"); // flip back
      await toggleVisibility(row);
      await toggleVisibility(row); // flip back

      // ── Cleanup ── open the editor and delete through the UI so the
      // run leaves nothing behind even if later steps fail.
      await row.getByRole("button", { name: `Edit ${agentName}` }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Delete agent" })
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      // Assert on the row itself — the name also surfaces in the right
      // chat panel and center editor, which stay rendered after deletion.
      await expect(row).not.toBeVisible({ timeout: 10_000 });
    },
  );
});
