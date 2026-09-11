import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";
import { BASE_NAMES } from "../constants/base-resources";

adminTest.describe("Chat Panel", () => {
  adminTest.beforeEach(async ({ page }) => {
    // Ensure the right panel is open before navigating.
    await page.addInitScript(() => {
      localStorage.setItem(
        "nango:sidebar",
        JSON.stringify({ state: { leftPanelOpen: false, rightPanelOpen: true }, version: 0 }),
      );
    });
  });

  adminTest("should show agent selection prompt when no agent is configured", async ({ page }) => {
    // Mock APIs to return empty lists, simulating no configured agents
    await page.route("**/api/builtin-agents*", async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });
    await page.route("**/api/agent-credentials*", async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });

    await gotoSettled(page, "/", page.getByText("Select an agent to start chatting."));
    await expect(page.getByText("Select an agent to start chatting.")).toBeVisible();
  });

  adminTest("should display the toolbar with active supervisor agent and controls", async ({ page }) => {
    await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));

    // 1. Agent selector trigger should show active agent (Nango supervisor is default)
    const trigger = page.getByTestId("agent-selector-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText(BASE_NAMES.supervisorAgent);

    // 2. Action buttons
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();

    // 3. Tab navigation buttons
    const chatTab = page.getByTestId("right-tab-chat");
    const historyTab = page.getByTestId("right-tab-history");
    await expect(chatTab).toBeVisible();
    await expect(historyTab).toBeVisible();
    await expect(chatTab).toHaveAttribute("aria-selected", "true");

    // 4. Chat panel body should be active
    await expect(page.getByTestId("chat-panel-body")).toBeVisible();
  });

  adminTest("should allow switching active agent via AgentSelector dropdown", async ({ page }) => {
    await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));

    const trigger = page.getByTestId("agent-selector-trigger");
    await trigger.click();

    // Select the base general agent using precise data-agent-name attribute
    const generalOption = page.locator(
      `[data-testid="agent-selector-item"][data-agent-name="${BASE_NAMES.generalAgent}"]`,
    );
    await expect(generalOption).toBeVisible();
    await generalOption.click();

    // Verify trigger reflects the newly selected agent
    await expect(trigger).toContainText(BASE_NAMES.generalAgent);
  });

  adminTest("should switch between Chat and History tabs", async ({ page }) => {
    await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));

    const chatTab = page.getByTestId("right-tab-chat");
    const historyTab = page.getByTestId("right-tab-history");
    const chatPanel = page.getByTestId("right-tabpanel-chat");
    const historyPanel = page.getByTestId("right-tabpanel-history");

    // Initially Chat tab is visible
    await expect(chatPanel).toBeVisible();
    await expect(historyPanel).toBeHidden();

    // Switch to History tab
    await historyTab.click();
    await expect(historyTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    await expect(historyPanel).toBeVisible();
    await expect(chatPanel).toBeHidden();

    // Switch back to Chat tab
    await chatTab.click();
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(historyTab).toHaveAttribute("aria-selected", "false");
    await expect(chatPanel).toBeVisible();
    await expect(historyPanel).toBeHidden();
  });

  adminTest("should handle New Chat click", async ({ page }) => {
    await gotoSettled(page, "/", page.getByTestId("agent-selector-trigger"));

    const newChatBtn = page.getByRole("button", { name: "New chat" });
    await expect(newChatBtn).toBeVisible();
    await newChatBtn.click();

    // Chat remains active and ready
    await expect(page.getByTestId("chat-panel-body")).toBeVisible();
    await expect(page.getByTestId("right-tab-chat")).toHaveAttribute("aria-selected", "true");
  });
});
