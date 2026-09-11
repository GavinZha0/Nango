/**
 * Shared interactions for the left-panel resource lists (agents, MCP
 * servers, skills, SSH servers, data sources). Every panel exposes the
 * same three aria-labelled controls (see AgentPanel / McpPanel /
 * SkillsPanel / SshServerPanel / DataSourcePanel), so tests can drive any
 * of them through these helpers instead of re-deriving selectors.
 *
 * The row toggle buttons all follow the pattern
 *   aria-label="Enable <noun>" / "Disable <noun>"  (noun = agent, skill,
 *   server, "SSH server", "data source")
 *   aria-label="Set to public" / "Set to private"   (identical everywhere)
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A single left-panel list row scoped by resource name. Panels mark their
 * rows with `data-testid="panel-row"` + `data-name` (see AgentPanel's
 * BuiltinRow — other panels adopt the same markers as they gain tests).
 * Falls back to text matching for panels not yet migrated.
 */
export function panelRow(page: Page, name: string): Locator {
  return page
    .getByTestId("panel-row")
    .filter({ hasText: name })
    .first();
}

/**
 * Click the enable/disable toggle on a panel row and assert the state
 * flipped. `noun` is the panel resource noun used in the aria-label
 * ("agent", "skill", "server", "SSH server", "data source").
 */
export async function toggleEnabled(row: Locator, noun?: string): Promise<void> {
  const toggleBtn = row.locator('[data-action="toggle-enabled"]');
  if (await toggleBtn.count() > 0) {
    const prevEnabled = await row.getAttribute("data-enabled");
    await toggleBtn.click();
    if (prevEnabled !== null) {
      const expected = prevEnabled === "true" ? "false" : "true";
      await expect(row).toHaveAttribute("data-enabled", expected);
    }
    return;
  }

  const enable = row.getByRole("button", { name: new RegExp(`Enable ${noun ?? ""}`) });
  const disable = row.getByRole("button", { name: new RegExp(`Disable ${noun ?? ""}`) });
  const wasEnabled = await disable.isVisible().catch(() => false);

  if (wasEnabled) {
    await disable.click();
    await expect(enable).toBeVisible();
  } else {
    await enable.click();
    await expect(disable).toBeVisible();
  }
}

/**
 * Click the visibility toggle on a panel row and assert the state flipped.
 * The aria-label is identical across panels ("Set to public/private").
 */
export async function toggleVisibility(row: Locator): Promise<void> {
  const toggleBtn = row.locator('[data-action="toggle-visibility"]');
  if (await toggleBtn.count() > 0) {
    const prevVis = await row.getAttribute("data-visibility");
    await toggleBtn.click();
    if (prevVis !== null) {
      const expected = prevVis === "public" ? "private" : "public";
      await expect(row).toHaveAttribute("data-visibility", expected);
    }
    return;
  }

  const toPrivate = row.getByRole("button", { name: /Set (.* )?to private/ });
  const toPublic = row.getByRole("button", { name: /Set (.* )?to public/ });
  const wasPublic = await toPrivate.isVisible().catch(() => false);

  if (wasPublic) {
    await toPrivate.click();
    await expect(toPublic).toBeVisible();
  } else {
    await toPublic.click();
    await expect(toPrivate).toBeVisible();
  }
}

/**
 * Click the "New <resource>" header button of a left panel. `ariaLabel` is
 * the button's aria-label, e.g. "New BuiltIn agent", "New MCP server",
 * "New skill", "New SSH server", "New data source", "New schedule".
 * Panels that navigate instead of opening a dialog (e.g. agents) just
 * navigate — the caller then waits for the destination page.
 */
export async function openNew(page: Page, ariaLabel: string): Promise<void> {
  await page.getByRole("button", { name: ariaLabel, exact: true }).click();
}
