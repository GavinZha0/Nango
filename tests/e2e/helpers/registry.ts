/**
 * Test-resource lifecycle. Every resource a test creates must be named via
 * `uniqueName()` (helpers/data.ts), which embeds the `-e2e-` marker. The
 * global teardown sweeps all domain tables for rows whose name carries the
 * marker and deletes them — a naming-convention contract rather than an
 * in-process registry, because `fullyParallel` workers and globalTeardown
 * run in separate processes and cannot share memory.
 *
 * CONTRACT: only resources named through `uniqueName()` are swept. A test
 * that hard-codes a name leaks rows until the whole DB is reset.
 */
import { expect, type Page } from "@playwright/test";

/** Marker embedded by uniqueName(); the teardown sweep matches on it. */
export const E2E_NAME_MARKER = "-e2e-";


/**
 * Self-cleanup used inside specs after a successful create: click the row's
 * delete button and confirm, so the row never survives even a failed run.
 * The global teardown sweep remains the backstop for crashed runs.
 */
export async function deleteRowByName(
  page: Page,
  name: string,
  dialogTitle: string | RegExp = /delete/i,
): Promise<void> {
  const row = page.getByRole("row").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole("button", { name: "Delete" }).click();
  // The confirm dialog renders as role=alertdialog (shadcn AlertDialog),
  // while the create/edit dialogs are role=dialog. Match by accessible name
  // instead so either variant works; the row Delete and the confirm Delete
  // share the label, so scope to the confirm alertdialog by title.
  const confirm = page
    .getByRole("alertdialog", { name: dialogTitle })
    .getByRole("button", { name: "Delete", exact: true });
  await confirm.click();
  await row.waitFor({ state: "detached", timeout: 10_000 });
}
