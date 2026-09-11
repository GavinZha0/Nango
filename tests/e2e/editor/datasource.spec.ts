import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { panelRow, toggleEnabled, toggleVisibility } from "../helpers/panels";
import { BASE_NAMES } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

editorTest.describe("Datasource Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/datasource", page.getByRole("heading", { name: "Data Sources" }));
  });

  // 1. Panel display and seeded Base Data Source verification
  editorTest(
    "should display the datasource panel, controls, and seeded base data source",
    async ({ page }) => {
      // Header controls
      await expect(page.getByTestId("new-datasource-button")).toBeVisible();
      await expect(page.getByTestId("refresh-datasources-button")).toBeVisible();

      // Seeded Base Data Source row
      const baseRow = panelRow(page, BASE_NAMES.dataSource);
      await expect(baseRow).toBeVisible();
      await expect(baseRow).toHaveAttribute("data-name", BASE_NAMES.dataSource);
      await expect(baseRow).toHaveAttribute("data-enabled", "false");
      await expect(baseRow).toHaveAttribute("data-visibility", "public");
      await expect(baseRow).toHaveAttribute("data-provider", "postgres");

      // Provider badge and host/database target text
      await expect(baseRow.locator('[data-testid="provider-badge"]')).toHaveText("postgres");
      await expect(baseRow.locator('[data-testid="target-info"]')).toHaveText("localhost:5432/nango_test");

      // RBAC for non-author editor on admin-created public row:
      // Can open/view, but cannot toggle enabled/visibility or delete
      await expect(baseRow.locator('[data-action="open-datasource"]')).toBeVisible();
      await expect(baseRow.locator('[data-action="toggle-enabled"]')).not.toBeVisible();
      await expect(baseRow.locator('[data-action="toggle-visibility"]')).not.toBeVisible();
    },
  );

  // 2. Read-only inspection of Base Data Source in editor
  editorTest(
    "should navigate to editor and inspect base data source details",
    async ({ page }) => {
      const baseRow = panelRow(page, BASE_NAMES.dataSource);
      await baseRow.locator('[data-action="open-datasource"]').click();

      // URL points to /datasource/<id>
      await page.waitForURL(/\/datasource\/[0-9a-f-]+/);
      await expect(page.getByTestId("datasource-editor-heading")).toHaveText(BASE_NAMES.dataSource);
      await expect(page.getByTestId("datasource-back-button")).toBeVisible();
      await expect(page.getByTestId("test-connection-button")).toBeVisible();
      await expect(page.getByTestId("save-datasource-button")).toBeVisible();

      // Form values match seeded Base Data Source
      const nameInput = page.getByTestId("ds-name-input");
      await expect(nameInput).toHaveValue(BASE_NAMES.dataSource);
      await expect(nameInput).toBeDisabled(); // Name cannot be changed after creation

      await expect(page.getByTestId("ds-host-input")).toHaveValue("localhost");
      await expect(page.getByTestId("ds-port-input")).toHaveValue("5432");
      await expect(page.getByTestId("ds-database-input")).toHaveValue("nango_test");
      await expect(page.getByTestId("ds-readonly-checkbox")).toBeChecked();

      // Navigate back to datasource list
      await page.getByTestId("datasource-back-button").click();
      await page.waitForURL(/\/datasource$/);
      await expect(panelRow(page, BASE_NAMES.dataSource)).toBeVisible();
    },
  );

  // 3. Ephemeral write flow: create data source, toggle, edit, and delete
  // CONTRACT: "只读基底 + 写操作自建自销毁" — base data sources are never modified.
  editorTest(
    "should create, toggle enabled and visibility, edit, and delete an ephemeral data source",
    async ({ page }) => {
      const name = uniqueName("ephemeral-ds");

      // 1. Open create form
      await page.getByTestId("new-datasource-button").click();
      await page.waitForURL(/\/datasource\/new/);
      await expect(page.getByTestId("datasource-editor-heading")).toHaveText("New data source");

      // 2. Fill in required fields
      await page.getByTestId("ds-name-input").fill(name);
      await page.getByTestId("ds-description-input").fill("Ephemeral test data source");
      await page.getByTestId("ds-host-input").fill("127.0.0.1");
      await page.getByTestId("ds-port-input").fill("5432");
      await page.getByTestId("ds-database-input").fill("ephemeral_db");

      // 3. Select seeded base datasource credential
      await page.getByTestId("ds-credential-select").click();
      await page.getByRole("option", { name: new RegExp(BASE_NAMES.datasourceCredential) }).click();

      // 4. Save and assert 201 Created
      const savePromise = page.waitForResponse(
        (res) => res.url().includes("/api/data-sources") && res.request().method() === "POST",
      );
      await page.getByTestId("save-datasource-button").click();
      const saveResp = await savePromise;
      expect(saveResp.status()).toBe(201);

      // 5. Lands on /datasource, new row appears in left panel
      await page.waitForURL(/\/datasource$/);
      const ephemeralRow = panelRow(page, name);
      await expect(ephemeralRow).toBeVisible();
      await expect(ephemeralRow).toHaveAttribute("data-name", name);
      await expect(ephemeralRow).toHaveAttribute("data-enabled", "true");
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");

      // 6. Toggle enabled (self-owned row has toggle action)
      await toggleEnabled(ephemeralRow, "data source");
      await expect(ephemeralRow).toHaveAttribute("data-enabled", "false");
      await toggleEnabled(ephemeralRow, "data source");
      await expect(ephemeralRow).toHaveAttribute("data-enabled", "true");

      // 7. Toggle visibility (self-owned row has toggle action)
      await toggleVisibility(ephemeralRow);
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "public");
      await toggleVisibility(ephemeralRow);
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");

      // 8. Open editor, update field and save
      await ephemeralRow.locator('[data-action="open-datasource"]').click();
      await page.waitForURL(/\/datasource\/[0-9a-f-]+/);

      await page.getByTestId("ds-description-input").fill("Updated ephemeral description");
      const patchPromise = page.waitForResponse(
        (res) => res.url().includes("/api/data-sources/") && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-datasource-button").click();
      const patchResp = await patchPromise;
      expect(patchResp.ok()).toBeTruthy();

      // 9. Re-open editor and delete ephemeral data source
      await page.waitForURL(/\/datasource$/);
      await panelRow(page, name).locator('[data-action="open-datasource"]').click();
      await page.waitForURL(/\/datasource\/[0-9a-f-]+/);

      await page.getByTestId("delete-datasource-button").click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      const deletePromise = page.waitForResponse(
        (res) => res.url().includes("/api/data-sources/") && res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-button").click();
      const delResp = await deletePromise;
      expect(delResp.status()).toBe(204);

      // 10. Lands on /datasource, row is removed
      await page.waitForURL(/\/datasource$/);
      await expect(panelRow(page, name)).not.toBeVisible();
    },
  );
});
