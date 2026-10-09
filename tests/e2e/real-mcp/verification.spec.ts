import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { adminTest } from "../helpers/fixtures";
import { panelRow } from "../helpers/panels";
import { BASE_NAMES, REAL_MCP_CONFIG } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

/**
 * Pre-flight network reachability probe.
 * Skips gracefully if external public endpoint is unreachable due to network conditions.
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

adminTest.describe("Real MCP Verification Subsystem Integration", () => {
  adminTest.describe.configure({ mode: "serial" });

  let serverName = "";
  let serverId = "";
  let suiteName = "";
  let suiteId = "";
  let caseId1 = 0;

  // Prepare: ensure a discovered Microsoft Learn MCP Server exists for verification testing
  adminTest.beforeAll(async ({ request }) => {
    const isReachable = await checkEndpointReachable(REAL_MCP_CONFIG.msLearnUrl);
    if (!isReachable) return;

    // Check existing MCP servers
    const listRes = await request.get("/api/mcp-servers");
    if (listRes.ok()) {
      const list = (await listRes.json()) as Array<{
        id: string;
        name: string;
        url: string;
        tools?: unknown[];
      }>;
      const existing = list.find((s) => s.name === BASE_NAMES.realMsLearnMcpServer);
      if (existing) {
        serverId = existing.id;
        serverName = existing.name;
        // Ensure tools are discovered
        if (!existing.tools || existing.tools.length === 0) {
          await request.post(`/api/mcp-servers/${existing.id}/discover`);
        }
      }
    }

    // If none exists, create one via API and trigger discovery
    if (!serverId) {
      serverName = uniqueName("Real-MsLearn-Verif");
      const createRes = await request.post("/api/mcp-servers", {
        data: {
          name: serverName,
          url: REAL_MCP_CONFIG.msLearnUrl,
          transport: "sse",
        },
      });
      if (createRes.ok()) {
        const body = (await createRes.json()) as { id: string };
        serverId = body.id;
        await request.post(`/api/mcp-servers/${serverId}/discover`);
      }
    }
  });

  // Cleanup created MCP server and suite if needed
  adminTest.afterAll(async ({ request }) => {
    if (suiteId) {
      await request.delete(`/api/verification-suites/${suiteId}`).catch(() => {});
    }
    if (serverId && serverName.startsWith("Real-MsLearn-Verif")) {
      await request.delete(`/api/mcp-servers/${serverId}`).catch(() => {});
    }
  });

  async function ensureChatPanelClosed(page: import("@playwright/test").Page) {
    const chatToggle = page.getByRole("button", { name: "Toggle chat panel" });
    if (await chatToggle.isVisible().catch(() => false)) {
      if ((await chatToggle.getAttribute("aria-pressed")) === "true") {
        await chatToggle.click();
      }
    }
  }

  adminTest.beforeEach(async () => {
    // Basic pre-flight check
    const isReachable = await checkEndpointReachable(REAL_MCP_CONFIG.msLearnUrl);
    adminTest.skip(!isReachable, "Microsoft Learn MCP Server endpoint is unreachable");
  });

  // 1. Create Verification Suite bound to Real MCP Server & Add Case with deterministic assertions
  adminTest(
    "1. should create Verification Suite bound to real MCP server and add case with jsonpath assertion",
    async ({ page }) => {
      suiteName = uniqueName("Real-MsLearn-Suite");

      await gotoSettled(page, "/verification", page.getByText("MCP Verification"));
      await ensureChatPanelClosed(page);

      // Open New Suite Dialog
      await page.getByTestId("new-suite-button").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      // Select real MCP server
      await page.getByTestId("suite-server-select").click();
      await page.getByRole("option", { name: new RegExp(serverName) }).click();

      // Fill suite name
      await page.getByTestId("suite-name-input").fill(suiteName);

      // Save suite
      const createSuitePromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-suites") && res.request().method() === "POST",
      );
      await page.getByTestId("save-suite-button").click();
      const createSuiteRes = await createSuitePromise;
      expect(createSuiteRes.status()).toBe(201);

      const createdSuite = (await createSuiteRes.json()) as { id: string };
      suiteId = createdSuite.id;

      // Lands on /verification/[suiteId]
      await page.waitForURL(new RegExp(`/verification/${suiteId}`));
      await expect(page.getByTestId("verification-suite-heading")).toContainText(suiteName);
      await ensureChatPanelClosed(page);

      // Click New Case button
      await page.getByTestId("new-case-button").click();
      const caseDialog = page.getByRole("dialog");
      await expect(caseDialog).toBeVisible();

      // Select real tool (microsoft_docs_search)
      await page.getByTestId("case-tool-select").click();
      await page.getByRole("option", { name: "microsoft_docs_search" }).click();

      // Fill case name
      await page.getByTestId("case-name-input").fill("010_search_azure");

      // Save case
      const createCasePromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-cases") && res.request().method() === "POST",
      );
      await page.getByTestId("save-case-dialog-button").click();
      const createCaseRes = await createCasePromise;
      expect(createCaseRes.status()).toBe(201);

      const createdCase = (await createCaseRes.json()) as { id: number };
      caseId1 = createdCase.id;

      // Select case row and edit input & assertions
      const caseRow = page.getByTestId("case-row").filter({ hasText: "010_search_azure" });
      await expect(caseRow).toBeVisible();

      const inputTextarea = page.getByTestId("case-input-textarea");
      await inputTextarea.fill('{"query": "azure storage"}');

      // Switch to assertions JSON tab and configure deterministic assertions
      await page.getByTestId("assertion-tab-json").click();
      const assertionsTextarea = page.getByTestId("assertions-json-textarea");
      const validAssertions = [
        {
          type: "jsonpath",
          path: "$.content[0].text",
          operator: "exists",
        },
        {
          type: "js_expression",
          expression: "root.content && root.content.length > 0",
        },
      ];
      await assertionsTextarea.fill(JSON.stringify(validAssertions, null, 2));

      // Save case modifications
      const patchPromise = page.waitForResponse(
        (res) => res.url().includes(`/api/verification-cases/${caseId1}`) && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-case-button").click();
      const patchRes = await patchPromise;
      expect(patchRes.ok()).toBeTruthy();
    },
  );

  // 2. Execute single Case (Run case) and verify deterministic assertion evaluation
  adminTest(
    "2. should execute single real MCP case, evaluate assertions against live payload, and pass",
    async ({ page }) => {
      await gotoSettled(page, `/verification/${suiteId}`, page.getByTestId("new-case-button"));
      await ensureChatPanelClosed(page);

      const caseRow = page.getByTestId("case-row").filter({ hasText: "010_search_azure" });
      await expect(caseRow).toBeVisible();
      await caseRow.click();

      // Run case
      const runCasePromise = page.waitForResponse(
        (res) =>
          res.url().includes(`/api/verification-cases/${caseId1}/run`) &&
          res.request().method() === "POST",
        { timeout: 25_000 },
      );
      await page.getByTestId("run-case-button").click();
      const runCaseRes = await runCasePromise;
      expect(runCaseRes.status()).toBe(200);

      const outcome = (await runCaseRes.json()) as {
        status: string;
        assertionResults?: Array<{ ok: boolean; type: string }>;
        resultPayload?: unknown;
      };

      // Assertions evaluate successfully on real returned payload
      expect(outcome.status).toBe("passed");
      expect(outcome.assertionResults?.length).toBe(2);
      expect(outcome.assertionResults?.every((r) => r.ok)).toBe(true);

      // Verify Output pane displays payload
      await expect(page.locator("text=Output").first()).toBeVisible();
      await expect(page.locator("text=azure").or(page.locator("text=Azure")).first()).toBeVisible();
    },
  );

  // 3. Negative assertion test: should fail when assertion condition is not met
  adminTest(
    "3. should evaluate negative assertion condition and report structured failure",
    async ({ page }) => {
      await gotoSettled(page, `/verification/${suiteId}`, page.getByTestId("new-case-button"));
      await ensureChatPanelClosed(page);

      const caseRow = page.getByTestId("case-row").filter({ hasText: "010_search_azure" });
      await expect(caseRow).toBeVisible();
      await caseRow.click();

      // Switch to JSON tab and inject an impossible assertion
      await page.getByTestId("assertion-tab-json").click();
      const assertionsTextarea = page.getByTestId("assertions-json-textarea");
      const failingAssertions = [
        {
          type: "jsonpath",
          path: "$.content[0].definitely_non_existent_key",
          operator: "exists",
        },
      ];
      await assertionsTextarea.fill(JSON.stringify(failingAssertions, null, 2));

      // Save case
      const patchPromise = page.waitForResponse(
        (res) => res.url().includes(`/api/verification-cases/${caseId1}`) && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-case-button").click();
      await patchPromise;

      // Run case
      const runCasePromise = page.waitForResponse(
        (res) =>
          res.url().includes(`/api/verification-cases/${caseId1}/run`) &&
          res.request().method() === "POST",
        { timeout: 25_000 },
      );
      await page.getByTestId("run-case-button").click();
      const runCaseRes = await runCasePromise;
      expect(runCaseRes.status()).toBe(200);

      const outcome = (await runCaseRes.json()) as {
        status: string;
        assertionResults?: Array<{ ok: boolean }>;
      };

      // Status should be failed due to assertion mismatch
      expect(outcome.status).toBe("failed");
      expect(outcome.assertionResults?.[0]?.ok).toBe(false);

      // Restore valid assertions for subsequent tests
      const validAssertions = [
        {
          type: "jsonpath",
          path: "$.content[0].text",
          operator: "exists",
        },
      ];
      await assertionsTextarea.fill(JSON.stringify(validAssertions, null, 2));
      const restorePromise = page.waitForResponse(
        (res) => res.url().includes(`/api/verification-cases/${caseId1}`) && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-case-button").click();
      await restorePromise;
    },
  );

  // 4. Batch suite execution: add second case, run full suite via SSE, and inspect run banner
  adminTest(
    "4. should add second case, execute full verification suite via SSE stream, and observe run results",
    async ({ page }) => {
      await gotoSettled(page, `/verification/${suiteId}`, page.getByTestId("new-case-button"));
      await ensureChatPanelClosed(page);

      // Add second case: 020_search_typescript
      await page.getByTestId("new-case-button").click();
      const caseDialog = page.getByRole("dialog");
      await expect(caseDialog).toBeVisible();

      await page.getByTestId("case-tool-select").click();
      await page.getByRole("option", { name: "microsoft_docs_search" }).click();
      await page.getByTestId("case-name-input").fill("020_search_typescript");

      const createCasePromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-cases") && res.request().method() === "POST",
      );
      await page.getByTestId("save-case-dialog-button").click();
      const createRes = await createCasePromise;
      expect(createRes.status()).toBe(201);

      // Configure second case input & assertions
      const inputTextarea = page.getByTestId("case-input-textarea");
      await inputTextarea.fill('{"query": "typescript interface"}');

      await page.getByTestId("assertion-tab-json").click();
      const assertionsTextarea = page.getByTestId("assertions-json-textarea");
      await assertionsTextarea.fill(
        JSON.stringify(
          [
            {
              type: "jsonpath",
              path: "$.content[0].text",
              operator: "exists",
            },
          ],
          null,
          2,
        ),
      );

      const patchPromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-cases/") && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-case-button").click();
      await patchPromise;

      // Trigger full suite run
      const runSuitePromise = page.waitForResponse(
        (res) => res.url().includes("/api/verification-runs") && res.request().method() === "POST",
        { timeout: 15_000 },
      );
      await page.getByTestId("run-suite-button").click();
      const runSuiteRes = await runSuitePromise;
      expect(runSuiteRes.status()).toBe(202);

      const runBody = (await runSuiteRes.json()) as { runId: string };
      expect(runBody.runId).toBeTruthy();

      // Wait for suite execution to finish and run chip to appear
      const runChip = page.getByTestId("run-chip").first();
      await expect(runChip).toBeVisible({ timeout: 30_000 });
      await expect(runChip).toHaveAttribute("data-run-status", "passed", { timeout: 30_000 });
    },
  );

  // 5. Cleanup suite via UI deletion dialog
  adminTest(
    "5. should navigate back to verification panel and delete the ephemeral suite",
    async ({ page }) => {
      await gotoSettled(page, `/verification/${suiteId}`, page.getByTestId("new-case-button"));

      // Back to /verification
      await page.getByTestId("verification-back-button").click();
      await page.waitForURL(/\/verification$/);

      const row = panelRow(page, suiteName);
      await expect(row).toBeVisible();

      // Delete suite
      await row.locator('[data-action="delete-suite"]').click();
      const alert = page.getByRole("alertdialog");
      await expect(alert).toBeVisible();

      const deletePromise = page.waitForResponse(
        (res) =>
          res.url().includes(`/api/verification-suites/${suiteId}`) &&
          res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-suite-button").click();
      const delRes = await deletePromise;
      expect(delRes.status()).toBe(204);

      // Verify row is removed
      await expect(row).not.toBeVisible();
      suiteId = ""; // cleared
    },
  );
});
