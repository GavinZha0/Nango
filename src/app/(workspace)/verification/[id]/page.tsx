/**
 * /verification/[id] — host page for `VerificationSuiteEditor`.
 *
 * Resolves the active row from the verification store (no extra fetch
 * when the left panel has already populated the list); kicks a refresh
 * on hard-load so the row eventually arrives. Remounts the editor via
 * `key={row.id}` when the row identity changes, so internal form state
 * never leaks between suites.
 *
 * `id === "new"` is a sentinel kept for symmetry with `/schedule/[id]`,
 * but Phase 5a does NOT yet support inline creation here — suite create
 * goes through the panel's `+` button which posts to
 * `POST /api/verification-suites`. The "new" path renders a brief
 * placeholder until Phase 5b adds the create dialog.
 */

"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";

import { VerificationSuiteEditor } from "@/components/main-panels/VerificationSuiteEditor";
import {
  useVerificationStore,
  verificationActions,
} from "@/store/verification";

export default function VerificationSuiteEditorPage(): ReactNode {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";

  const row = useVerificationStore((s) =>
    isNew
      ? undefined
      : s.items.mcp.find((it) => it.id === id) ??
        s.items.workflow.find((it) => it.id === id),
  );

  const mcpLoaded = useVerificationStore((s) => s.loaded.mcp);
  const workflowLoaded = useVerificationStore((s) => s.loaded.workflow);

  // Hard-nav fallback. Try MCP first (Workflow is V2 today) then fall
  // through to Workflow if MCP didn't contain the row. Both categories
  // need to be exhausted before we conclude "not found".
  useEffect(() => {
    if (isNew || row) return;
    if (!mcpLoaded) {
      void verificationActions.refresh("mcp");
      return;
    }
    if (!workflowLoaded) {
      void verificationActions.refresh("workflow");
    }
  }, [isNew, row, mcpLoaded, workflowLoaded]);

  if (isNew) {
    return (
      <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
        <p>
          Use the <strong>+</strong> button in the left panel to create a
          verification suite.
        </p>
      </div>
    );
  }

  if (!row) {
    return (
      <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
        <p>Loading verification suite…</p>
      </div>
    );
  }

  return (
    <VerificationSuiteEditor
      key={row.id}
      row={row}
      onBack={() => router.push("/verification")}
    />
  );
}
