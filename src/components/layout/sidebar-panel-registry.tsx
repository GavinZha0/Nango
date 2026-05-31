"use client";

/**
 * Registry of left-side panels.
 */

import type { ComponentType } from "react";
import {
  LayoutDashboard,
  Sparkles,
  Bot,
  Plug,
  BicepsFlexed,
  Calendar,
  Database,
  Server,
} from "lucide-react";
import type { LeftPanelId } from "@/store/sidebar";
import { LEFT_PANEL_IDS } from "@/store/sidebar";

// Panel components

import { DashboardPanel } from "@/components/left-panels/DashboardPanel";
import { ArtifactPanel } from "@/components/left-panels/ArtifactPanel";
import { AgentPanel } from "@/components/left-panels/AgentPanel";
import { McpPanel } from "@/components/left-panels/McpPanel";
import { SkillsPanel } from "@/components/left-panels/SkillsPanel";
import { SchedulesPanel } from "@/components/left-panels/SchedulesPanel";
import { DataSourcePanel } from "@/components/left-panels/DataSourcePanel";
import { SshServerPanel } from "@/components/left-panels/SshServerPanel";

// Types

type PanelIcon = ComponentType<{ className?: string }>;
type PanelComponent = ComponentType;

export interface SidebarPanelDefinition {
  id: LeftPanelId;
  label: string;
  icon: PanelIcon;
  component: PanelComponent;
  /**
   * URL prefix this panel owns. The toolbar clicks `router.push(href)`
   * (not `setActiveLeftPanel`) so the panel state lives in the URL —
   * bookmarkable, shareable, F5-resilient, and browser-history-aware.
   * Panel-detail routes (`<href>/<id>`) live as nested segments under
   * the same prefix so `pathname.startsWith(href)` keeps the panel
   * highlighted while a detail page is open.
   *
   * Note: `id` and `href` differ in one place — the `schedules` panel
   * owns `/schedule` (singular), matching the existing /schedule route.
   * @see docs/copilotkit-provider-lifecycle.md "URL navigation contract"
   */
  href: string;
  /**
   * Minimum role required to see / open this panel. Defaults to `"user"`
   * (visible to everyone signed-in). See docs/rbac.md
   */
  requiredRole?: "user" | "editor" | "admin";
}

// Registry

export const SIDEBAR_PANEL_REGISTRY: Record<LeftPanelId, SidebarPanelDefinition> = {
  // User group (no requiredRole — visible to everyone)
  dashboard: {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    component: DashboardPanel,
    href: "/dashboard",
  },
  artifact: {
    id: "artifact",
    label: "Artifacts",
    icon: Sparkles,
    component: ArtifactPanel,
    href: "/artifact",
  },
  schedules: {
    id: "schedules",
    label: "Schedules",
    icon: Calendar,
    component: SchedulesPanel,
    href: "/schedule",
  },

  // Editor group — agent resource management
  agent: {
    id: "agent",
    label: "Agents",
    icon: Bot,
    component: AgentPanel,
    href: "/agent",
    requiredRole: "editor",
  },
  mcp: {
    id: "mcp",
    label: "MCP",
    icon: Plug,
    component: McpPanel,
    href: "/mcp",
    requiredRole: "editor",
  },
  skills: {
    id: "skills",
    label: "Skills",
    icon: BicepsFlexed,
    component: SkillsPanel,
    href: "/skills",
    requiredRole: "editor",
  },
  datasource: {
    id: "datasource",
    label: "Data Sources",
    icon: Database,
    component: DataSourcePanel,
    href: "/datasource",
    requiredRole: "editor",
  },
  "ssh-server": {
    id: "ssh-server",
    label: "SSH Hosts",
    icon: Server,
    component: SshServerPanel,
    href: "/ssh-server",
    requiredRole: "editor",
  },
};

/** Ordered list of left-panel items for toolbar rendering. */
export const SIDEBAR_PANEL_ITEMS: SidebarPanelDefinition[] = LEFT_PANEL_IDS.map(
  (id: LeftPanelId): SidebarPanelDefinition => SIDEBAR_PANEL_REGISTRY[id]
);

/**
 * Map a Next.js pathname to the panel that owns it, or `null` when
 * no registered panel claims the route (e.g. `/`, `/notifications`,
 * `/admin/...`). The matching is `startsWith(href)` so detail pages
 * like `/agent/<id>` resolve to the `agent` panel.
 *
 * URL is the single source of truth for which panel is open —
 * `SidePanel` and `ThreePanelContent` both call this helper instead
 * of reading `useSidebarStore`. The sidebar store no longer carries
 * an `activeLeftPanel` field; only the right-panel state remains.
 *
 * Order matters when one panel's href is a prefix of another's. We
 * iterate by descending href length so a future `/ssh-server-foo`
 * panel wouldn't shadow `/ssh-server`. (No such conflict today.)
 */
const PANEL_LOOKUP: ReadonlyArray<readonly [string, LeftPanelId]> = (
  LEFT_PANEL_IDS.map((id) => [SIDEBAR_PANEL_REGISTRY[id].href, id] as const)
).slice().sort((a, b) => b[0].length - a[0].length);

export function resolveActivePanel(pathname: string): LeftPanelId | null {
  for (const [href, id] of PANEL_LOOKUP) {
    if (pathname === href || pathname.startsWith(`${href}/`)) return id;
  }
  return null;
}
