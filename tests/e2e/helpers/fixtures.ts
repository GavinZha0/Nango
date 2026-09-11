import { test as base } from "@playwright/test";

/**
 * Role-scoped test objects. Each pre-configures the saved auth-state cookie
 * jar for one seeded user (see fixtures/auth-states.setup.ts), so specs no
 * longer repeat `test.use({ storageState: "..." })` with a hand-written path
 * that could drift from the setup project.
 */

export const adminTest = base.extend({
  storageState: "tests/e2e/.auth/admin.json",
});

export const editorTest = base.extend({
  storageState: "tests/e2e/.auth/editor.json",
});

export const userTest = base.extend({
  storageState: "tests/e2e/.auth/user.json",
});