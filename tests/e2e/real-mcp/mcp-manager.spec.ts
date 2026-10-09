import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";
import { panelRow } from "../helpers/panels";
import { BASE_NAMES, REAL_MCP_CONFIG } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

/**
 * Pre-flight network reachability probe.
 * Skips gracefully if the external public endpoint is unreachable due to network conditions.
 */
async function checkEndpointReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "e2e-probe", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(7000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

adminTest.describe("Real MCP Server Management & Tool Tester", () => {
  adminTest.describe.configure({ mode: "serial" });

  adminTest.beforeEach(async ({ page }) => {
    // Navigate to /mcp which mounts McpPanel in the left sidebar
    await gotoSettled(page, "/mcp", page.getByRole("heading", { name: "MCP Servers" }));
  });

  let msLearnServerName = "";

  // 1. Enable pre-seeded Mock MCP Server and manually refresh to fetch tool schemas
  adminTest(
    "1. should enable a pre-seeded Mock MCP server and manually refresh to fetch tool schemas into DB",
    async ({ page }) => {
      const isReachable = await checkEndpointReachable(REAL_MCP_CONFIG.complexServerUrl);
      adminTest.skip(!isReachable, "Complex Schema MCP Server endpoint is unreachable");

      const complexRow = panelRow(page, BASE_NAMES.realComplexMcpServer);
      await expect(complexRow).toBeVisible();

      // Step 1: If initially disabled, test the enable toggle
      const isEnabled = (await complexRow.getAttribute("data-enabled")) === "true";
      if (!isEnabled) {
        const toggleBtn = complexRow.getByTestId("toggle-enabled-button");
        await expect(toggleBtn).toBeVisible({ timeout: 10_000 });
        const patchPromise = page.waitForResponse(
          (res) => res.url().includes("/api/mcp-servers/") && res.request().method() === "PATCH",
        );
        await toggleBtn.click();
        await patchPromise;
        await expect(complexRow).toHaveAttribute("data-enabled", "true");
      }

      // Step 2: Ensure refresh button is enabled and ready
      const refreshBtn = complexRow.getByTestId("refresh-tools-button");
      await expect(refreshBtn).toBeVisible({ timeout: 15_000 });
      await expect(refreshBtn).toBeEnabled({ timeout: 10_000 });

      // Step 3: Trigger discovery via the row's refresh button
      const discoverPromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/mcp-servers/") &&
          res.url().includes("/discover") &&
          res.request().method() === "POST",
        { timeout: 20_000 },
      );

      await refreshBtn.click();
      let discoverRes = await discoverPromise;
      if (discoverRes.status() !== 200) {
        await page.waitForTimeout(1500);
        const retryPromise = page.waitForResponse(
          (res) =>
            res.url().includes("/api/mcp-servers/") &&
            res.url().includes("/discover") &&
            res.request().method() === "POST",
          { timeout: 20_000 },
        );
        await refreshBtn.click();
        discoverRes = await retryPromise;
      }
      expect(discoverRes.status()).toBe(200);

      // Step 4: Verify tool count badge updates to 4 (create_user_profile, process_order, analyze_data, configure_workflow)
      const countBadge = complexRow.locator('[data-testid="tool-count-badge"]');
      await expect(countBadge).toBeVisible();
      await expect(countBadge).toHaveText("4");

      // Verify server version badge updates to v2.0.0 from initialize
      const versionBadge = complexRow.locator('[data-testid="server-version-badge"]');
      await expect(versionBadge).toHaveText("v2.0.0");
    },
  );

  // 2. UI Create Dialog with Auto-Discovery for Microsoft Learn
  adminTest(
    "2. should create Microsoft Learn MCP server via UI dialog and automatically discover tools",
    async ({ page }) => {
      const isReachable = await checkEndpointReachable(REAL_MCP_CONFIG.msLearnUrl);
      adminTest.skip(!isReachable, "Microsoft Learn MCP Server endpoint is unreachable");

      msLearnServerName = uniqueName("Real-MsLearn");

      // 1. Open New MCP Server dialog
      await page.getByTestId("new-mcp-server-button").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "New MCP Server" })).toBeVisible();

      // 2. Fill in server details
      await page.getByTestId("mcp-name-input").fill(msLearnServerName);
      await page.getByTestId("mcp-url-input").fill(REAL_MCP_CONFIG.msLearnUrl);

      // 3. Submit and wait for both server creation and auto-discovery
      const createPromise = page.waitForResponse(
        (res) => res.url().includes("/api/mcp-servers") && res.request().method() === "POST",
        { timeout: 10_000 },
      );
      const autoDiscoverPromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/mcp-servers/") &&
          res.url().includes("/discover") &&
          res.request().method() === "POST",
        { timeout: 15_000 },
      );

      await page.getByTestId("mcp-submit-button").click();
      const createRes = await createPromise;
      expect(createRes.status()).toBe(201);

      const autoDiscoverRes = await autoDiscoverPromise;
      expect(autoDiscoverRes.status()).toBe(200);

      // 4. Verify new row appeared with 3 discovered tools
      const newRow = panelRow(page, msLearnServerName);
      await expect(newRow).toBeVisible();
      await expect(newRow.locator('[data-testid="tool-count-badge"]')).toHaveText("3");
    },
  );

  // 3. Tool tester navigation, parameter form rendering, and live execution
  adminTest(
    "3. should navigate to tool test page, execute real tool, and inspect return value",
    async ({ page }) => {
      const isReachable = await checkEndpointReachable(REAL_MCP_CONFIG.msLearnUrl);
      adminTest.skip(!isReachable, "Microsoft Learn MCP Server endpoint is unreachable");

      const targetServer = msLearnServerName || BASE_NAMES.realComplexMcpServer;
      const targetRow = panelRow(page, targetServer);
      await expect(targetRow).toBeVisible();

      // Navigate to /mcp/test/[serverId]
      await targetRow.locator('[data-action="open-mcp-server"]').click();
      await page.waitForURL(/\/mcp\/test\/[0-9a-f-]+/);

      const heading = page.getByTestId("mcp-test-heading");
      await expect(heading).toContainText(targetServer);

      // Select real tool (microsoft_docs_search on msLearn)
      const toolName = targetServer === msLearnServerName ? "microsoft_docs_search" : "analyze_data";
      const toolItem = page.locator(
        `[data-testid="mcp-tool-item"][data-tool-name="${toolName}"]`,
      );
      await expect(toolItem).toBeVisible();
      await toolItem.click();

      // Switch to Json tab to provide valid search query
      await page.getByRole("button", { name: "Json", exact: true }).click();
      const jsonTextarea = page.locator("textarea").first();
      await jsonTextarea.fill(
        targetServer === msLearnServerName ? '{"query": "azure"}' : '{"dataSource": "test_metrics"}',
      );

      const runButton = page.getByTestId("mcp-run-button");
      await expect(runButton).toBeVisible();

      // Trigger tool execution via /call-tool
      const execPromise = page.waitForResponse(
        (res) =>
          res.url().includes("/call-tool") &&
          res.request().method() === "POST",
        { timeout: 20_000 },
      );

      await runButton.click({ force: true });
      const execRes = await execPromise;
      expect(execRes.status()).toBe(200);

      // Inspect execution results in result panel
      await page.getByRole("button", { name: "Raw Json" }).click();
      const rawPre = page.locator("pre").filter({ hasText: /result|content|title|url|summary/i }).first();
      await expect(rawPre).toBeVisible();

      // Return back to /mcp
      await page.getByTestId("mcp-test-back-button").click();
      await page.waitForURL(/\/mcp$/);
    },
  );

  // 4. Error handling on Error MCP Server
  adminTest(
    "4. should enable Error MCP Server, discover tools, and gracefully capture structured error",
    async ({ page }) => {
      const isReachable = await checkEndpointReachable(REAL_MCP_CONFIG.errorServerUrl);
      adminTest.skip(!isReachable, "Error MCP Server endpoint is unreachable");

      const errorRow = panelRow(page, BASE_NAMES.realErrorMcpServer);
      await expect(errorRow).toBeVisible();

      // Step 1: Base seed initial state is enabled=false. Test enabling it in UI
      const isEnabled = (await errorRow.getAttribute("data-enabled")) === "true";
      if (!isEnabled) {
        const toggleBtn = errorRow.getByTestId("toggle-enabled-button");
        const patchPromise = page.waitForResponse(
          (res) => res.url().includes("/api/mcp-servers/") && res.request().method() === "PATCH",
        );
        await toggleBtn.click();
        await patchPromise;
        await expect(errorRow).toHaveAttribute("data-enabled", "true");
      }

      // Step 2: Ensure refresh button is enabled
      const refreshBtn = errorRow.getByTestId("refresh-tools-button");
      await expect(refreshBtn).toBeVisible({ timeout: 15_000 });
      await expect(refreshBtn).toBeEnabled({ timeout: 10_000 });

      // Step 3: Trigger discovery via refresh button
      const discoverPromise = page.waitForResponse(
        (res) => res.url().includes("/discover") && res.request().method() === "POST",
        { timeout: 20_000 },
      );
      await refreshBtn.click();
      let discoverRes = await discoverPromise;
      if (discoverRes.status() !== 200) {
        await page.waitForTimeout(1500);
        const retryPromise = page.waitForResponse(
          (res) => res.url().includes("/discover") && res.request().method() === "POST",
          { timeout: 20_000 },
        );
        await refreshBtn.click();
        discoverRes = await retryPromise;
      }
      expect(discoverRes.status()).toBe(200);

      // Verify tool count updates to 3 (simulate_error, throw_unhandled, timeout_operation)
      const countBadge = errorRow.locator('[data-testid="tool-count-badge"]');
      await expect(countBadge).toBeVisible();
      await expect(countBadge).toHaveText("3");

      // Navigate to test page
      await errorRow.locator('[data-action="open-mcp-server"]').click();
      await page.waitForURL(/\/mcp\/test\/[0-9a-f-]+/);

      // Select simulate_error tool
      const errorToolItem = page.locator(
        '[data-testid="mcp-tool-item"][data-tool-name="simulate_error"]',
      );
      await expect(errorToolItem).toBeVisible();
      await errorToolItem.click();

      // Switch to Json tab and provide required "errorType"
      await page.getByRole("button", { name: "Json", exact: true }).click();
      const jsonTextarea = page.locator("textarea").first();
      await jsonTextarea.fill('{"errorType": "server_error"}');

      // Execute tool expecting failure
      const runButton = page.getByTestId("mcp-run-button");
      const execPromise = page.waitForResponse(
        (res) => res.url().includes("/call-tool") && res.request().method() === "POST",
        { timeout: 20_000 },
      );
      await runButton.click({ force: true });
      const execRes = await execPromise;
      expect([200, 400, 500, 502]).toContain(execRes.status());

      // Assert error message displayed in result area without app crash
      const errorIndicator = page
        .locator("text=BAD_GATEWAY")
        .or(page.locator("text=isError"))
        .or(page.locator("text=error"))
        .or(page.locator("text=Simulated"));
      await expect(errorIndicator.first()).toBeVisible();

      // Return back to /mcp
      await page.getByTestId("mcp-test-back-button").click();
      await page.waitForURL(/\/mcp$/);
    },
  );

  // 5. Cross-module Save As Case dialog integration and lifecycle cleanup
  adminTest(
    "5. should save successful MCP execution as a verification case via Save as Case dialog",
    async ({ page }) => {
      const isReachable = await checkEndpointReachable(REAL_MCP_CONFIG.msLearnUrl);
      adminTest.skip(!isReachable, "Microsoft Learn MCP Server endpoint is unreachable");

      const targetServer = msLearnServerName || BASE_NAMES.realComplexMcpServer;
      const targetRow = panelRow(page, targetServer);
      await expect(targetRow).toBeVisible();

      await targetRow.locator('[data-action="open-mcp-server"]').click();
      await page.waitForURL(/\/mcp\/test\/[0-9a-f-]+/);

      // Select and execute tool
      const toolName = targetServer === msLearnServerName ? "microsoft_docs_search" : "analyze_data";
      const toolItem = page.locator(
        `[data-testid="mcp-tool-item"][data-tool-name="${toolName}"]`,
      );
      await toolItem.click();

      await page.getByRole("button", { name: "Json", exact: true }).click();
      const jsonTextarea = page.locator("textarea").first();
      await jsonTextarea.fill(
        targetServer === msLearnServerName ? '{"query": "azure"}' : '{"dataSource": "test_metrics"}',
      );

      const runButton = page.getByTestId("mcp-run-button");
      const execPromise = page.waitForResponse(
        (res) => res.url().includes("/call-tool") && res.request().method() === "POST",
        { timeout: 20_000 },
      );
      await runButton.click({ force: true });
      const execRes = await execPromise;
      expect(execRes.status()).toBe(200);

      // Click "Save as case"
      const saveCaseButton = page.getByRole("button", { name: "Save as case" });
      await expect(saveCaseButton).toBeEnabled();
      await saveCaseButton.click();

      // Verify SaveAsCaseDialog is open
      const saveDialog = page.getByRole("dialog");
      await expect(saveDialog).toBeVisible();
      await expect(saveDialog.getByRole("heading", { name: "Save as Verification Case" })).toBeVisible();

      // Submit save case
      const saveCasePromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-cases") && res.request().method() === "POST",
        { timeout: 10_000 },
      );
      await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
      const saveRes = await saveCasePromise;
      expect(saveRes.status()).toBe(201);
      await expect(saveDialog).not.toBeVisible();

      // Return back to /mcp
      await page.getByTestId("mcp-test-back-button").click();
      await page.waitForURL(/\/mcp$/);

      // Cleanup: delete ephemeral UI-created msLearn server row
      if (msLearnServerName) {
        const rowToDelete = panelRow(page, msLearnServerName);
        if (await rowToDelete.isVisible().catch(() => false)) {
          const deleteBtn = rowToDelete.getByTestId("delete-server-button");
          if (await deleteBtn.isVisible().catch(() => false)) {
            await deleteBtn.click();
            const alertDialog = page.getByRole("alertdialog");
            await expect(alertDialog).toBeVisible();

            const deletePromise = page.waitForResponse(
              (res) => res.url().includes("/api/mcp-servers/") && res.request().method() === "DELETE",
              { timeout: 10_000 },
            );
            await page.getByTestId("mcp-confirm-delete-button").click();
            await deletePromise;
            await expect(rowToDelete).not.toBeVisible();
          }
        }
      }
    },
  );
});
