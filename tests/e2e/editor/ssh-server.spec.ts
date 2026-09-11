import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { panelRow, toggleEnabled, toggleVisibility } from "../helpers/panels";
import { BASE_NAMES } from "../constants/base-resources";
import { uniqueName } from "../helpers/data";

editorTest.describe("SSH Server Page", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/ssh-server", page.getByRole("heading", { name: "SSH Hosts" }));
  });

  // 1. Panel display and seeded Base SSH Server verification
  editorTest(
    "should display the SSH server panel, controls, and seeded base SSH server",
    async ({ page }) => {
      // Header controls
      await expect(page.getByTestId("new-ssh-server-button")).toBeVisible();
      await expect(page.getByTestId("refresh-ssh-servers-button")).toBeVisible();

      // Seeded Base SSH Server row
      const baseRow = panelRow(page, BASE_NAMES.sshServer);
      await expect(baseRow).toBeVisible();
      await expect(baseRow).toHaveAttribute("data-name", BASE_NAMES.sshServer);
      await expect(baseRow).toHaveAttribute("data-enabled", "false");
      await expect(baseRow).toHaveAttribute("data-visibility", "public");

      // Host target text (port 22 defaults to host-only label)
      await expect(baseRow.locator('[data-testid="target-info"]')).toHaveText("localhost");

      // RBAC for non-author editor on admin-created public row:
      // Can open/view, but cannot toggle enabled/visibility or delete
      await expect(baseRow.locator('[data-action="open-ssh-server"]')).toBeVisible();
      await expect(baseRow.locator('[data-action="toggle-enabled"]')).not.toBeVisible();
      await expect(baseRow.locator('[data-action="toggle-visibility"]')).not.toBeVisible();
    },
  );

  // 2. Read-only inspection of Base SSH Server in editor
  editorTest(
    "should navigate to editor and inspect base SSH server details",
    async ({ page }) => {
      const baseRow = panelRow(page, BASE_NAMES.sshServer);
      await baseRow.locator('[data-action="open-ssh-server"]').click();

      // URL points to /ssh-server/<id>
      await page.waitForURL(/\/ssh-server\/[0-9a-f-]+/);
      await expect(page.getByTestId("ssh-editor-heading")).toHaveText(BASE_NAMES.sshServer);
      await expect(page.getByTestId("ssh-back-button")).toBeVisible();
      await expect(page.getByTestId("verify-connection-button")).toBeVisible();
      await expect(page.getByTestId("save-ssh-server-button")).toBeVisible();

      // Form values match seeded Base SSH Server
      const nameInput = page.getByTestId("ssh-name-input");
      await expect(nameInput).toHaveValue(BASE_NAMES.sshServer);
      await expect(nameInput).toBeDisabled(); // Name cannot be changed after creation

      await expect(page.getByTestId("ssh-host-input")).toHaveValue("localhost");
      await expect(page.getByTestId("ssh-port-input")).toHaveValue("22");
      await expect(page.getByTestId("ssh-fingerprint-input")).toHaveValue(
        "SHA256:dGVzdGZpbmdlcnByaW50ZXhhbXBsZTEyMzQ1Njc4OTA=",
      );
      await expect(page.getByTestId("ssh-login-shell-switch")).toBeChecked();

      // Navigate back to SSH server list
      await page.getByTestId("ssh-back-button").click();
      await page.waitForURL(/\/ssh-server$/);
      await expect(panelRow(page, BASE_NAMES.sshServer)).toBeVisible();
    },
  );

  // 3. Ephemeral write flow: create SSH server, toggle, edit, and delete
  // CONTRACT: "只读基底 + 写操作自建自销毁" — base SSH servers are never modified.
  editorTest(
    "should create, toggle enabled and visibility, edit, and delete an ephemeral SSH server",
    async ({ page }) => {
      const name = uniqueName("ephemeral-ssh");

      // 1. Open create form
      await page.getByTestId("new-ssh-server-button").click();
      await page.waitForURL(/\/ssh-server\/new/);
      await expect(page.getByTestId("ssh-editor-heading")).toHaveText("New SSH server");

      // 2. Fill in required fields
      await page.getByTestId("ssh-name-input").fill(name);
      await page.getByTestId("ssh-description-input").fill("Ephemeral test SSH server");
      await page.getByTestId("ssh-host-input").fill("127.0.0.1");
      await page.getByTestId("ssh-port-input").fill("2222");

      // 3. Select seeded base SSH credential
      await page.getByTestId("ssh-credential-select").click();
      await page.getByRole("option", { name: new RegExp(BASE_NAMES.sshCredential) }).click();

      // 4. Fill pre-formed fingerprint to bypass live host key probe
      await page
        .getByTestId("ssh-fingerprint-input")
        .fill("SHA256:dGVzdGZpbmdlcnByaW50ZXhhbXBsZTEyMzQ1Njc4OTA=");

      // 5. Save and assert 201 Created
      const savePromise = page.waitForResponse(
        (res) => res.url().includes("/api/ssh-servers") && res.request().method() === "POST",
      );
      await page.getByTestId("save-ssh-server-button").click();
      const saveResp = await savePromise;
      expect(saveResp.status()).toBe(201);

      // 6. Lands on /ssh-server, new row appears in left panel
      await page.waitForURL(/\/ssh-server$/);
      const ephemeralRow = panelRow(page, name);
      await expect(ephemeralRow).toBeVisible();
      await expect(ephemeralRow).toHaveAttribute("data-name", name);
      await expect(ephemeralRow).toHaveAttribute("data-enabled", "true");
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");
      await expect(ephemeralRow.locator('[data-testid="target-info"]')).toHaveText("127.0.0.1:2222");

      // 7. Toggle enabled (self-owned row has toggle action)
      await toggleEnabled(ephemeralRow, "SSH server");
      await expect(ephemeralRow).toHaveAttribute("data-enabled", "false");
      await toggleEnabled(ephemeralRow, "SSH server");
      await expect(ephemeralRow).toHaveAttribute("data-enabled", "true");

      // 8. Toggle visibility (self-owned row has toggle action)
      await toggleVisibility(ephemeralRow);
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "public");
      await toggleVisibility(ephemeralRow);
      await expect(ephemeralRow).toHaveAttribute("data-visibility", "private");

      // 9. Open editor, update field and save
      await ephemeralRow.locator('[data-action="open-ssh-server"]').click();
      await page.waitForURL(/\/ssh-server\/[0-9a-f-]+/);

      await page.getByTestId("ssh-description-input").fill("Updated ephemeral description");
      const patchPromise = page.waitForResponse(
        (res) => res.url().includes("/api/ssh-servers/") && res.request().method() === "PATCH",
      );
      await page.getByTestId("save-ssh-server-button").click();
      const patchResp = await patchPromise;
      expect(patchResp.ok()).toBeTruthy();

      // 10. Re-open editor and delete ephemeral SSH server
      await page.waitForURL(/\/ssh-server$/);
      await panelRow(page, name).locator('[data-action="open-ssh-server"]').click();
      await page.waitForURL(/\/ssh-server\/[0-9a-f-]+/);

      await page.getByTestId("delete-ssh-server-button").click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      const deletePromise = page.waitForResponse(
        (res) => res.url().includes("/api/ssh-servers/") && res.request().method() === "DELETE",
      );
      await page.getByTestId("confirm-delete-button").click();
      const delResp = await deletePromise;
      expect(delResp.status()).toBe(204);

      // 11. Lands on /ssh-server, row is removed
      await page.waitForURL(/\/ssh-server$/);
      await expect(panelRow(page, name)).not.toBeVisible();
    },
  );
});
