"use client";

/**
 * PanelRedirectPage — index page for a left-panel section.
 *
 * Renders the shared `<WelcomePage>` in the center area; the matching
 * left panel is picked by `SidePanel` from `usePathname()`. We do not
 * touch any store here — that would violate the right-panel URL
 * invariants in docs/copilotkit-provider-lifecycle.md.
 *
 * The `panel` prop is accepted but not read; it lets each
 * `(workspace)/<section>/page.tsx` self-document which panel it owns.
 */

import type { LeftPanelId } from "@/store/sidebar";
import { WelcomePage } from "@/components/layout/WelcomePage";

interface PanelRedirectPageProps {
  /** Documentation-only — the section this route owns. Not read at
   *  runtime; SidePanel resolves the active panel from pathname. */
  panel: LeftPanelId;
}

export function PanelRedirectPage(props: PanelRedirectPageProps) {
  // `data-panel` lets devtools answer "which section route am I on?".
  return (
    <div data-panel={props.panel} className="contents">
      <WelcomePage />
    </div>
  );
}
