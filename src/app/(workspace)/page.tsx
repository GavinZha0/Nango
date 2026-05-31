"use client";

/**
 * `/` — the workspace welcome / landing page.
 *
 * Pure landing screen. Thread transients render at `/outcomes`;
 * saved artifacts at `/artifact/[id]`. The JSX here is shared with
 * every panel-index route via `<WelcomePage>`.
 */

import { WelcomePage } from "@/components/layout/WelcomePage";

export default function WorkspacePage() {
  return <WelcomePage />;
}
