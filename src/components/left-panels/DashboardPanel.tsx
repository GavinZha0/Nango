"use client";

import type { ReactNode } from "react";
import { LayoutDashboard } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

/** DashboardPanel — Phase 3 placeholder for published dashboards browser. */
export function DashboardPanel(): ReactNode {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Dashboards</h2>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
          <LayoutDashboard className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            Published dashboards will appear here.
          </p>
        </div>
      </ScrollArea>
    </div>
  );
}
