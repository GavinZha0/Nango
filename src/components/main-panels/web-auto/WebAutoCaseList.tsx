"use client";

import type { ReactNode } from "react";
import { BaseCaseList, type BaseCaseListProps } from "@/components/main-panels/common";
import type { WebAutoCaseRow } from "@/store/web-auto-store";

export interface CaseVerdict {
  status: "passed" | "failed" | "errored" | "running" | null;
  durationMs?: number | null;
}

export interface WebAutoCaseListProps extends BaseCaseListProps<WebAutoCaseRow, CaseVerdict> {
  mcpServerId?: string | null;
}

export function WebAutoCaseList({
  mcpServerId,
  ...props
}: WebAutoCaseListProps): ReactNode {
  return (
    <BaseCaseList<WebAutoCaseRow, CaseVerdict>
      {...props}
      runDisabled={!mcpServerId}
      renderExtra={(_c, verdict) =>
        verdict?.durationMs !== undefined &&
        verdict.durationMs !== null &&
        verdict.durationMs > 0 ? (
          <span className="text-[10px] text-muted-foreground font-mono shrink-0">
            {(verdict.durationMs / 1000).toFixed(1)}s
          </span>
        ) : null
      }
    />
  );
}
