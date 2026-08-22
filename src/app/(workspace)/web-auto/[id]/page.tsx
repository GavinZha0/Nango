"use client";

import { type ReactNode } from "react";
import { useParams } from "next/navigation";
import { WebAutoEditor } from "@/components/main-panels/web-auto/WebAutoEditor";

export default function WebAutoSuitePage(): ReactNode {
  const { id } = useParams<{ id: string }>();

  if (!id) {
    return (
      <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
        <p>Invalid suite ID.</p>
      </div>
    );
  }

  return <WebAutoEditor suiteId={id} />;
}
