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
import type { Page } from "@playwright/test";

/** Marker embedded by uniqueName(); the teardown sweep matches on it. */
export const E2E_NAME_MARKER = "-e2e-";

const tracked: Array<{ kind: string; name: string }> = [];

/**
 * Register an in-test reference for readability — call it right after the
 * UI confirms the resource exists. The sweep itself only needs the naming
 * marker; this list exists so specs can assert/track what they created
 * inside the run (and for future per-run reporting).
 */
export function trackResource(kind: string, name: string): void {
  tracked.push({ kind, name });
}

export function trackedResources(): ReadonlyArray<{ kind: string; name: string }> {
  return tracked;
}

/**
 * Self-cleanup used inside specs after a successful create: click the row's
 * delete button and confirm, so the row never survives even a failed run.
 * The global teardown sweep remains the backstop for crashed runs.
 */
export async function deleteRowByName(page: Page, name: string): Promise<void> {
  const row = page.getByRole("row").filter({ hasText: name });
  if (!(await row.isVisible().catch(() => false))) return;
  await row.getByRole("button", { name: "Delete" }).click();
  // The confirm dialog renders as role=alertdialog (shadcn AlertDialog),
  // while the create/edit dialogs are role=dialog. Match by accessible name
  // instead so either variant works; the row Delete and the confirm Delete
  // share the label, so scope to the "Delete credential" alertdialog.
  const confirm = page
    .getByRole("alertdialog", { name: /delete credential/i })
    .getByRole("button", { name: "Delete", exact: true });
  await confirm.click();
  await row.waitFor({ state: "detached", timeout: 10_000 });
}
