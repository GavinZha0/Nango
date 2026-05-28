"use client";

/**
 * PanelRedirectPage — index page for a left-panel section.
 *
 * Each `/agent`, `/skills`, `/mcp`, `/datasource`, `/ssh-server`,
 * `/schedule`, `/dashboard`, `/artifact` route mounts this. It is
 * a thin presentational shell:
 *
 *   - The matching left panel is chosen by `SidePanel`, which
 *     derives the active panel id from `usePathname()` via
 *     `resolveActivePanel`. We do NOT touch any store here.
 *   - The center area renders the shared `<WelcomePage>` so users
 *     land on a friendly "you are here, nothing is selected yet"
 *     surface instead of an empty pane.
 *
 * The `panel` prop is accepted (and ignored) only as a label for
 * grep / docs / future per-section customization — keeping it as
 * part of the call signature makes each `(workspace)/<section>/page.tsx`
 * self-documenting about which panel it owns.
 *
 * @see docs/copilotkit-provider-lifecycle.md "URL navigation contract"
 *      for why route changes within (workspace)/ do NOT remount the
 *      right panel or its CopilotKitProvider.
 */

import type { LeftPanelId } from "@/store/sidebar";
import { WelcomePage } from "@/components/layout/WelcomePage";

interface PanelRedirectPageProps {
  /** Documentation-only — the section this route owns. Not read at
   *  runtime; SidePanel resolves the active panel from pathname. */
  panel: LeftPanelId;
}

export function PanelRedirectPage(props: PanelRedirectPageProps) {
  // Annotate the rendered root with a data attribute for debugging
  // ("which section route am I on?"). Keeps the `panel` prop from
  // being a pure no-op while preserving the future customization
  // hook described in the file-level comment.
  return (
    <div data-panel={props.panel} className="contents">
      <WelcomePage />
    </div>
  );
}
