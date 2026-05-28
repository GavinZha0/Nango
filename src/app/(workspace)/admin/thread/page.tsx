import type { ReactNode } from "react";
import { MessagesSquare } from "lucide-react";

import { ThreadManagement } from "@/components/admin/ThreadManagement";

export const metadata = { title: "Threads — Nango" };

export default function AdminThreadPage(): ReactNode {
  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <div className="flex items-center gap-3">
        <MessagesSquare className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-bold tracking-tight">Threads</h1>
          <p className="text-sm text-muted-foreground">
            Forensic view of every conversation thread. Each row aggregates
            the runs that share a `thread_id`; click a row to see the run
            timeline and per-run event details.
          </p>
        </div>
      </div>
      <ThreadManagement />
    </div>
  );
}
