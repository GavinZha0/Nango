import type { ReactNode } from "react";
import { Activity } from "lucide-react";

import { requireEditor } from "@/lib/auth/route-guards";
import { TraceManagement } from "@/components/trace/TraceManagement";

export default async function TracePage(): Promise<ReactNode> {
  await requireEditor();

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto px-6 py-6">
      <div className="flex items-center gap-2">
        <Activity className="h-4.5 w-4.5 text-muted-foreground" />
        <h1 className="text-base font-semibold">Traces</h1>
      </div>
      <TraceManagement />
    </div>
  );
}
