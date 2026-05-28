"use client";

/**
 * `/` — the workspace welcome / landing page.
 *
 * Before V1 of the Outcomes panel, this page also handled a
 * full-screen single-artifact priority branch via
 * `workspaceStore.activeArtifact`. That field was scaffolding from
 * an abandoned Phase 3 plan; no chat-side caller ever opened it.
 * See `docs/data-visualization.md` §6.4 — the new model is:
 *   - `/outcomes` shows the current thread's transient panel
 *   - `/artifact/[id]` (V2) will show a saved-artifact detail view
 * The welcome page is now purely a landing screen. The JSX is
 * shared with every panel-index route via `<WelcomePage>`.
 */

import { WelcomePage } from "@/components/layout/WelcomePage";

export default function WorkspacePage() {
  return <WelcomePage />;
}
