import type { ReactNode } from "react";

import { requireEditor } from "@/lib/auth/route-guards";
import { TraceDetailView } from "@/components/trace/TraceDetailView";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TraceDetailPage({ params }: PageProps): Promise<ReactNode> {
  await requireEditor();
  const { id } = await params;

  return <TraceDetailView traceId={id} />;
}
