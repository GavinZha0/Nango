"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";

import { VerificationSuiteEditor } from "@/components/main-panels/VerificationSuiteEditor";
import {
  useVerificationStore,
  verificationActions,
  type VerificationServerRow,
} from "@/store/verification";

export default function VerificationServerPage(): ReactNode {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const serverRow = useVerificationStore((s) =>
    s.items.mcp.find((it) => it.id === id),
  ) as unknown as VerificationServerRow | undefined;

  const mcpLoaded = useVerificationStore((s) => s.loaded.mcp);

  useEffect(() => {
    if (serverRow) return;
    if (!mcpLoaded) {
      void verificationActions.refresh("mcp");
    }
  }, [serverRow, mcpLoaded]);

  if (!serverRow) {
    return (
      <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
        <p>Loading verification server…</p>
      </div>
    );
  }

  return (
    <VerificationSuiteEditor
      key={serverRow.id}
      row={serverRow}
      onBack={() => router.push("/verification")}
    />
  );
}
