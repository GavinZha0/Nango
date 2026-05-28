"use client";

/**
 * SidePanel — container for the collapsible left panel.
 *
 * Which panel renders is derived from `usePathname()` via
 * `resolveActivePanel()`. The sidebar store no longer carries an
 * `activeLeftPanel` field — URL is the single source of truth.
 */

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  SIDEBAR_PANEL_REGISTRY,
  resolveActivePanel,
} from "@/components/layout/sidebar-panel-registry";

export function SidePanel(): ReactNode {
  const pathname = usePathname();
  const activePanel = resolveActivePanel(pathname);

  if (!activePanel) return null;

  const definition = SIDEBAR_PANEL_REGISTRY[activePanel];
  if (!definition) return null;

  const PanelComponent = definition.component;

  return (
    <div className="h-full overflow-hidden border-r" style={{ backgroundColor: "var(--panel-bg)" }}>
      <PanelComponent />
    </div>
  );
}
