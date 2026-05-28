"use client";

/**
 * WelcomePage — the "Welcome to Nango" landing card.
 *
 * Shared by `(workspace)/page.tsx` (the `/` root) and every panel
 * index route (`/agent`, `/skills`, `/mcp`, `/datasource`,
 * `/ssh-server`, `/schedule`, `/dashboard`, `/artifact`). The
 * index routes render this in the center area while the matching
 * left panel is open — giving users a stable "you are here, nothing
 * is selected yet" surface that's friendlier than an empty pane.
 *
 * Pure presentation: no router, no store. Anything that wants to
 * surface "select something / create new" affordances lives in the
 * surrounding left panel, not here.
 */

import { LayoutDashboard, MessageSquare, TrendingUp } from "lucide-react";
import type { ReactNode } from "react";

export function WelcomePage(): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
        <LayoutDashboard className="h-8 w-8 text-primary" />
      </div>

      <div className="max-w-md space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">
          Welcome to Nango
        </h1>
        <p className="text-muted-foreground">
          Your AI-powered workspace. Connect data sources, generate dashboards,
          and let agents build artifacts for you — all in one place.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          {
            icon: TrendingUp,
            title: "Data Analysis",
            desc: "Connect databases and explore data visually",
          },
          {
            icon: MessageSquare,
            title: "AI Chat",
            desc: "Ask agents to create charts and dashboards",
          },
          {
            icon: LayoutDashboard,
            title: "Outcomes",
            desc: "Generated charts collected per conversation",
          },
        ].map(({ icon: Icon, title, desc }) => (
          <div
            key={title}
            className="rounded-xl border bg-card p-5 text-left shadow-sm"
          >
            <Icon className="mb-3 h-6 w-6 text-primary" />
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
          </div>
        ))}
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Open the Chat panel on the right to get started
      </p>
    </div>
  );
}
