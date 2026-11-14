import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { panelRow, toggleEnabled, toggleVisibility } from "../helpers/panels";
import { BASE_NAMES } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

editorTest.describe("MCP Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    // /mcp opens McpPanel in the left sidebar and WelcomePage in the center
    await gotoSettled(page, "/mcp", page.getByTestId("mcp-tab-installed"));
  });

  // 1. Read-only base inspection in the panel
  editorTest("should display the MCP panel, controls, and seeded base server", async ({ page }) => {
    await expect(page.getByTestId("mcp-tab-installed")).toBeVisible();
    await expect(page.getByTestId("mcp-tab-market")).toBeVisible();
    await expect(page.getByTestId("new-mcp-server-button")).toBeVisible();
    await expect(page.getByTestId("refresh-mcp-servers-button")).toBeVisible();

    const baseRow = panelRow(page, BASE_NAMES.mcpServer);
    await expect(baseRow).toBeVisible();
    await expect(baseRow).toHaveAttribute("data-name", BASE_NAMES.mcpServer);
    await expect(baseRow).toHaveAttribute("data-enabled", "false");
    await expect(baseRow).toHaveAttribute("data-visibility", "public");

    // Version badge (v1.0.0)
    await expect(baseRow.locator('[data-testid="version-badge"]')).toHaveText("v1.0.0");

    // Verify row actions for editor on public base server created by admin:
    // Editors can inspect and refresh public resources, but RBAC strictly forbids
    // non-author editors from deleting or toggling visibility/enabled status.
    await expect(baseRow.locator('[data-action="open-mcp-server"]')).toBeVisible();
    await expect(baseRow.locator('[data-action="refresh-tools"]')).toBeVisible();
    await expect(baseRow.locator('[data-action="edit-server"]')).toBeVisible();
    await expect(baseRow.locator('[data-action="delete-server"]')).not.toBeVisible();
    await expect(baseRow.locator('[data-action="toggle-enabled"]')).not.toBeVisible();
    await expect(baseRow.locator('[data-action="toggle-visibility"]')).not.toBeVisible();
  });

  // 2. Read-only navigation to tool test page
  editorTest("should navigate to tool test page and inspect tool details", async ({ page }) => {
    const baseRow = panelRow(page, BASE_NAMES.mcpServer);
    await baseRow.locator('[data-action="open-mcp-server"]').click();

    await page.waitForURL(/\/mcp\/test\/[0-9a-f-]+/);
    const heading = page.getByTestId("mcp-test-heading");
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(BASE_NAMES.mcpServer);

    // Verify tool list shows the seeded tool
    const toolItem = page.locator('[data-testid="mcp-tool-item"][data-tool-name="echo_tool"]');
    await expect(toolItem).toBeVisible();
    await expect(toolItem).toContainText("echo_tool");

    // Verify tool search input is functional
    const searchInput = page.getByTestId("mcp-tool-search-input");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("nonexistent-tool-query");
    await expect(page.locator("text=No tools match")).toBeVisible();
    await searchInput.fill("");
    await expect(toolItem).toBeVisible();

    // Navigate back to /mcp
    await page.getByTestId("mcp-test-back-button").click();
    await page.waitForURL(/\/mcp$/);
    await expect(page.getByTestId("mcp-tab-installed")).toBeVisible();
  });

  // 3. Ephemeral CRUD lifecycle (Create -> Toggle -> Edit -> Delete)
  editorTest("should create, toggle enabled and visibility, edit, and delete an ephemeral MCP server", async ({ page }) => {
    const ephemeralName = uniqueName("Ephemeral-Mcp");

    // 1. Open New MCP Server dialog
    await page.getByTestId("new-mcp-server-button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "New MCP Server" })).toBeVisible();

    // 2. Fill form
    await page.getByTestId("mcp-name-input").fill(ephemeralName);
    await page.getByTestId("mcp-url-input").fill("https://example.com/mcp");

    // Intercept POST request to assert exact 201 status
    const createPromise = page.waitForResponse(
      (r) => r.url().includes("/api/mcp-servers") && r.request().method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("mcp-submit-button").click();
    const createRes = await createPromise;
    expect(createRes.status()).toBe(201);

    // Dialog closes and new server row appears
    await expect(dialog).not.toBeVisible();
    const ephemeralRow = panelRow(page, ephemeralName);
    await expect(ephemeralRow).toBeVisible();

    // 3. Toggle enabled and visibility
    await toggleEnabled(ephemeralRow, "server");
    await expect(ephemeralRow).toHaveAttribute("data-enabled", "false");
    await toggleEnabled(ephemeralRow, "server");
    await expect(ephemeralRow).toHaveAttribute("data-enabled", "true");

    await toggleVisibility(ephemeralRow);
    await expect(ephemeralRow).toHaveAttribute("data-visibility", "public");
    await toggleVisibility(ephemeralRow);
    await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");

    // 4. Edit server (open edit dialog, check prefilled name, cancel)
    await ephemeralRow.locator('[data-action="edit-server"]').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Edit MCP Server" })).toBeVisible();
    await expect(page.getByTestId("mcp-name-input")).toHaveValue(ephemeralName);
    await page.getByTestId("mcp-cancel-button").click();
    await expect(dialog).not.toBeVisible();

    // 5. Delete server with confirmation dialog
    await ephemeralRow.locator('[data-action="delete-server"]').click();
    const alertDialog = page.getByRole("alertdialog");
    await expect(alertDialog).toBeVisible();
    await expect(alertDialog.getByRole("heading", { name: "Delete MCP server" })).toBeVisible();

    const deletePromise = page.waitForResponse(
      (r) => r.url().includes("/api/mcp-servers/") && r.request().method() === "DELETE",
      { timeout: 10_000 },
    );
    await page.getByTestId("mcp-confirm-delete-button").click();
    const deleteRes = await deletePromise;
    expect(deleteRes.ok()).toBeTruthy();

    // Verify row detached from panel
    await expect(ephemeralRow).not.toBeVisible();
  });

  // 4. Market Tab: search, prefill install, installed state, and cleanup
  editorTest("should browse, search, install from Market tab, and mark as installed", async ({ page }) => {
    await page.getByTestId("mcp-tab-market").click();

    const searchInput = page.getByTestId("mcp-market-search");
    await expect(searchInput).toBeVisible();
    await expect(page.getByTestId("mcp-market-item-playwright")).toBeVisible();

    // Filter by search query
    await searchInput.fill("sequential");
    await expect(page.getByTestId("mcp-market-item-sequential-thinking")).toBeVisible();
    await expect(page.getByTestId("mcp-market-item-playwright")).not.toBeVisible();

    // Clear search and pick the first uninstalled market item so the test is resilient to pre-existing DB state
    await searchInput.fill("");
    const firstInstallBtn = page.locator('[data-testid^="mcp-market-install-"]:not([disabled])').first();
    await expect(firstInstallBtn).toBeVisible();
    const installTestId = (await firstInstallBtn.getAttribute("data-testid"))!;
    const itemName = ((await firstInstallBtn.getAttribute("aria-label")) ?? "").replace(/^Install\s+/, "");

    // Click Install icon -> opens prefilled ServerFormDialog
    await firstInstallBtn.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: `Install ${itemName}` })).toBeVisible();
    await expect(page.getByTestId("mcp-name-input")).toHaveValue(itemName);

    const createPromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/mcp-servers") && r.request().method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("mcp-submit-button").click();
    const createRes = await createPromise;
    expect(createRes.status()).toBe(201);
    await expect(dialog).not.toBeVisible();

    // Switches back to Installed tab and shows the newly installed server
    const installedRow = panelRow(page, itemName);
    await expect(installedRow).toBeVisible();

    // Switch back to Market tab -> item button is now disabled with "Installed" tooltip
    await page.getByTestId("mcp-tab-market").click();
    await searchInput.fill(itemName);
    const installedMarketBtn = page.getByTestId(installTestId);
    await expect(installedMarketBtn).toBeDisabled();
    await expect(installedMarketBtn.locator("..")).toHaveAttribute("title", "Installed");

    // Clean up: switch to Installed and delete the ephemeral server
    await page.getByTestId("mcp-tab-installed").click();
    await installedRow.locator('[data-action="delete-server"]').click();
    const deletePromise = page.waitForResponse(
      (r) => r.url().includes("/api/mcp-servers/") && r.request().method() === "DELETE",
      { timeout: 10_000 },
    );
    await page.getByTestId("mcp-confirm-delete-button").click();
    const deleteRes = await deletePromise;
    expect(deleteRes.ok()).toBeTruthy();
    await expect(installedRow).not.toBeVisible();
  });
});
