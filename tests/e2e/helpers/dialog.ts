/**
 * Shared dialog helpers. Form dialogs across the app (credential, data
 * source, SSH server, …) follow the same shape: a role=dialog container
 * with labelled inputs and a labelled submit button. Scoped helpers here
 * keep specs from colliding with same-named toolbar buttons.
 */
import { expect, type Locator } from "@playwright/test";

/**
 * Fill a form dialog from a label→value map, then click the submit
 * button, and assert the dialog closed.
 *
 * Labels are matched case-insensitively via regex (`/name/i` style is NOT
 * applied — pass the visible label text). Order of object keys is the
 * fill order.
 *
 * `submitLabel` is matched exactly to avoid "Create" vs "Creating…"
 * partial-match issues; pass e.g. "Create", "Save", "Add".
 */
export async function fillAndSubmit(
  dialog: Locator,
  fields: Record<string, string>,
  submitLabel: string,
): Promise<void> {
  for (const [label, value] of Object.entries(fields)) {
    await dialog.getByLabel(label, { exact: false }).first().fill(value);
  }
  await dialog.getByRole("button", { name: submitLabel, exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
