import { test as base, type Page } from "@playwright/test";

/**
 * Persistently suppress CopilotKit dev-inspector overlay across all
 * navigations. addInitScript runs before any page script, so the style is
 * injected into every document (unlike addStyleTag, which is lost upon
 * page.goto navigation).
 */
async function suppressCopilotInspector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.setAttribute("data-e2e", "cpk-inspector-guard");
    style.textContent = "cpk-web-inspector { display: none !important; pointer-events: none !important; }";
    (document.head || document.documentElement).appendChild(style);
  });
}

/**
 * Role-scoped test objects. Each pre-configures the saved auth-state cookie
 * jar for one seeded user (see fixtures/auth-states.setup.ts), so specs no
 * longer repeat `test.use({ storageState: "..." })` with a hand-written path
 * that could drift from the setup project.
 */
export const adminTest = base.extend({
  storageState: "tests/e2e/.auth/admin.json",
  page: async ({ page }, bind) => {
    await suppressCopilotInspector(page);
    await bind(page);
  },
});

export const editorTest = base.extend({
  storageState: "tests/e2e/.auth/editor.json",
  page: async ({ page }, bind) => {
    await suppressCopilotInspector(page);
    await bind(page);
  },
});

export const userTest = base.extend({
  storageState: "tests/e2e/.auth/user.json",
  page: async ({ page }, bind) => {
    await suppressCopilotInspector(page);
    await bind(page);
  },
});