"use client";

import { mutate } from "swr";
import { caseActions } from "@/store/verification-cases";
import { evalCaseActions } from "@/store/evaluation-cases";

export interface InvalidateTestModuleCacheOptions {
  category: "verification" | "evaluation" | "web-auto";
  suiteId?: string | null;
  toolName?: string;
}

/**
 * Single source of truth for invalidating client caches (SWR and Zustand)
 * across testing subsystems after a mutation tool execution.
 */
export function invalidateTestModuleCache({
  category,
  suiteId,
  toolName,
}: InvalidateTestModuleCacheOptions): void {
  void toolName;

  if (category === "verification") {
    // 1. Invalidate MCP suites list and server tree
    void mutate("/api/verification-suites");
    void mutate("/api/verification-servers");

    // 2. Invalidate specific suite and refresh Zustand cases store
    if (suiteId) {
      void mutate(`/api/verification-suites/${suiteId}`);
      void caseActions.refresh(suiteId);
    }
  } else if (category === "evaluation") {
    // 1. Invalidate eval suites list and agent tree
    void mutate("/api/eval-suites");
    void mutate("/api/eval-suites/agents");

    // 2. Invalidate specific suite and refresh Zustand cases store
    if (suiteId) {
      void mutate(`/api/eval-suites/${suiteId}`);
      void evalCaseActions.refresh(suiteId);
    }
  } else if (category === "web-auto") {
    // 1. Invalidate web-auto suites list
    void mutate("/api/web-auto-suites");

    // 2. Invalidate specific suite and SWR cases list
    if (suiteId) {
      void mutate(`/api/web-auto-suites/${suiteId}`);
      void mutate(`/api/web-auto-suites/${suiteId}/cases`);
    }
  }
}
