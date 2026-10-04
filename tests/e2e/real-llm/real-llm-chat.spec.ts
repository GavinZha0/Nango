import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";
import { uniqueName } from "../helpers/data";
import { openNew, panelRow } from "../helpers/panels";
import { deleteRowByName } from "../helpers/registry";
import { BASE_NAMES, REAL_LLM_CONFIG } from "../constants/base-resources";

// Temporarily skipped pending real LLM service stability tuning
adminTest.describe.skip("Real LLM Conversation & Forensics", { tag: "@real-llm" }, () => {
  adminTest.describe.configure({ mode: "serial" });

  adminTest.beforeEach(async ({ page }) => {
    // Skip entire suite if no real LLM API Key is configured in environment
    adminTest.skip(
      !REAL_LLM_CONFIG.apiKey,
      "Skipping real LLM tests: No API Key configured for real LLM.",
    );

    // Ensure both panels are open for navigation and chat
    await page.addInitScript(() => {
      localStorage.setItem(
        "nango:sidebar",
        JSON.stringify({ state: { leftPanelOpen: true, rightPanelOpen: true }, version: 0 }),
      );
    });
  });

  // Test Case 1: Pure UI Flow for Credential creation & Agent building (Visibility, Configuration & Self-cleaning)
  adminTest(
    "1. should create credentials and build builtin agent via UI, verifying visibility, configuration, and self-cleaning",
    async ({ page }) => {
      const credName = uniqueName("Custom-LLM-Cred");
      const agentName = uniqueName("Custom-LLM-Agent");

      // ── Step 1: Create Credential via UI ──
      await gotoSettled(
        page,
        "/admin/credential",
        page.getByText("Credentials", { exact: true }).first(),
        { accessPath: "/admin/credential" },
      );

      await page.getByRole("button", { name: "New Credential" }).click();
      const credDialog = page.getByRole("dialog");
      await expect(credDialog.getByRole("heading", { name: "New Credential" })).toBeVisible();

      // Fill Name
      await credDialog.getByLabel(/name/i).first().fill(credName);

      // Select Provider (button label in ProviderPicker)
      const providerLabel = REAL_LLM_CONFIG.provider === "groq" ? "Groq" : "OpenAI";
      await credDialog.getByRole("button", { name: providerLabel, exact: true }).click();

      // Select API Key type
      await credDialog.getByRole("combobox", { name: "Credential Type" }).click();
      await page.getByRole("option", { name: "API Key", exact: true }).click();

      // Fill secret API Key
      await credDialog
        .getByLabel("API Key")
        .fill(REAL_LLM_CONFIG.apiKey);

      // Submit form
      await credDialog.getByRole("button", { name: "Create", exact: true }).click();

      // Dialog should close and new credential should be visible in table
      await expect(credDialog).not.toBeVisible({ timeout: 10_000 });
      const credRow = page.getByRole("row").filter({ hasText: credName });
      await expect(credRow).toBeVisible({ timeout: 10_000 });
      await expect(
        credRow.getByRole("cell", { name: REAL_LLM_CONFIG.provider, exact: true }),
      ).toBeVisible();

      // ── Step 2: Build BuiltIn Agent via UI ──
      await gotoSettled(
        page,
        "/agent",
        page.getByRole("button", { name: "New BuiltIn agent" }),
      );

      await openNew(page, "New BuiltIn agent");
      await page.waitForURL(/\/agent\/new/);

      // Fill Name
      await page.getByLabel("Name").fill(agentName);

      // Select newly created credential from Provider combobox
      await page.getByRole("combobox", { name: "Provider" }).click();
      const credOption = page.getByRole("option", { name: new RegExp(credName) });
      await credOption.waitFor({ state: "visible", timeout: 10_000 });
      await credOption.click();

      // Fill Model ID (using configurable REAL_LLM_CONFIG.model)
      await page.getByLabel("Model ID").fill(REAL_LLM_CONFIG.model);

      // Save agent
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForURL(/\/agent$/);

      // Verify agent in left panel
      const agentRow = panelRow(page, agentName);
      await expect(agentRow).toBeVisible({ timeout: 10_000 });

      // Inspect details via UI
      await agentRow.getByRole("button", { name: `Edit ${agentName}` }).click();
      await page.waitForURL(/\/agent\/[0-9a-f-]+/);
      await expect(page.getByLabel("Name")).toHaveValue(agentName);
      await expect(page.getByLabel("Model ID")).toHaveValue(REAL_LLM_CONFIG.model);

      // ── Step 3: Verify agent appears in Dashboard AgentSelector dropdown via UI ──
      await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));
      const trigger = page.getByTestId("agent-selector-trigger");
      await trigger.click();

      const builtinGroupHeader = page.getByTestId("agent-group-builtin");
      const agentOption = page.locator(
        `[data-testid="agent-selector-item"][data-agent-name="${agentName}"]`,
      );

      if (!(await agentOption.isVisible())) {
        if (await builtinGroupHeader.isVisible()) {
          await builtinGroupHeader.click();
        }
      }
      await expect(agentOption).toBeVisible({ timeout: 5000 });
      await agentOption.click();
      await expect(trigger).toContainText(agentName);

      // ── Step 4: UI Self-cleaning (Delete agent and credential via UI) ──
      // 4a. Delete agent via UI
      await gotoSettled(page, "/agent", page.getByRole("button", { name: "New BuiltIn agent" }));
      const deleteAgentRow = panelRow(page, agentName);
      await expect(deleteAgentRow).toBeVisible({ timeout: 10_000 });
      await deleteAgentRow.getByRole("button", { name: `Edit ${agentName}` }).click();
      await page.waitForURL(/\/agent\/[0-9a-f-]+/);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Delete agent" })
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await page.waitForURL(/\/agent$/);
      await expect(panelRow(page, agentName)).not.toBeVisible({ timeout: 10_000 });

      // 4b. Delete credential via UI
      await gotoSettled(
        page,
        "/admin/credential",
        page.getByText("Credentials", { exact: true }).first(),
        { accessPath: "/admin/credential" },
      );
      await deleteRowByName(page, credName);
      await expect(page.getByRole("row").filter({ hasText: credName })).toHaveCount(0);
    },
  );

  // Test Case 2: Real conversation with LLM agent, verifying history and trace forensics
  adminTest(
    "2. should chat with real LLM agent, verifying response, conversation history, and trace forensics",
    async ({ page }) => {
      adminTest.setTimeout(90_000);

      const phraseToEcho = "Good good study";
      const promptText = `Please repeat: ${phraseToEcho}`;

      // 1. Navigate to Dashboard and switch to our seeded Base Real LLM agent
      await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));

      const trigger = page.getByTestId("agent-selector-trigger");
      await trigger.click();

      const builtinGroupHeader = page.getByTestId("agent-group-builtin");
      const agentOption = page.locator(
        `[data-testid="agent-selector-item"][data-agent-name="${BASE_NAMES.realLlmAgent}"]`,
      );

      if (!(await agentOption.isVisible())) {
        if (await builtinGroupHeader.isVisible()) {
          await builtinGroupHeader.click();
        }
      }
      await expect(agentOption).toBeVisible({ timeout: 10_000 });
      await agentOption.click();
      await expect(trigger).toContainText(BASE_NAMES.realLlmAgent);

      // 2. Send plain echo prompt to agent and wait for real LLM streaming response
      const chatInput = page.getByPlaceholder(/Message the agent/i);
      await expect(chatInput).toBeVisible({ timeout: 10_000 });
      await chatInput.fill(promptText);
      await chatInput.press("Enter");

      // Wait specifically for the assistant's response message to arrive and contain phraseToEcho
      const assistantMsg = page.locator(".copilotKitAssistantMessage").last();
      await expect(assistantMsg).toBeVisible({ timeout: 40_000 });
      await expect(assistantMsg).toContainText(phraseToEcho, { timeout: 40_000 });

      // Wait for streaming to finalize (loading cursor disappears and message controls appear)
      await expect(page.getByTestId("copilot-loading-cursor")).not.toBeVisible({ timeout: 20_000 });
      await expect(
        assistantMsg.locator(".copilotKitMessageControls, [aria-label*='Regenerate']").first(),
      ).toBeVisible({ timeout: 20_000 });

      // 3. Verify conversation history recorded in History tab
      const historyTab = page.getByTestId("right-tab-history");
      await historyTab.click();
      await expect(historyTab).toHaveAttribute("aria-selected", "true");

      const historyPanel = page.getByTestId("right-tabpanel-history");
      await expect(historyPanel).toBeVisible();

      // Check that a session with our prompt was recorded in the history list
      await expect(
        historyPanel.getByText(phraseToEcho, { exact: false }),
      ).toBeVisible({ timeout: 15_000 });

      // 4. Verify execution forensics in /trace
      await gotoSettled(
        page,
        "/trace",
        page.getByRole("heading", { name: "Traces", exact: true }),
        { accessPath: "/trace" },
      );

      const traceRow = page.getByRole("link", { name: new RegExp(phraseToEcho) });
      await expect(traceRow.first()).toBeVisible({ timeout: 15_000 });
      await traceRow.first().click();

      await page.waitForURL(/\/trace\/[0-9a-f-]+/);

      // Verify trace header and status badge
      await expect(page.getByRole("heading", { name: /Trace /i })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("succeeded", { exact: true })).toBeVisible({ timeout: 15_000 });
      const summarySection = page.locator("section").filter({ hasText: "Runs" });
      await expect(summarySection).toBeVisible();
      await expect(summarySection.getByText("Runs", { exact: true })).toBeVisible();

      // Verify Run tree in timeline: top run #1 exists and reflects the task
      const topRun = page.getByRole("button").filter({ hasText: "#1" }).first();
      await expect(topRun).toBeVisible();
      await topRun.click();

      // Verify events pane is loaded and displays the run forensics
      await expect(page.getByRole("heading", { name: /events/i })).toBeVisible();
      await expect(page.locator("body")).toContainText(phraseToEcho);
    },
  );
});
