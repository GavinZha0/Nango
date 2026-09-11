"use client";

import { useRouter, useParams } from "next/navigation";
import { BuiltinAgentEditor } from "@/components/main-panels/BuiltinAgentEditor";
import type { BuiltinAgentRow } from "@/lib/types/builtin-agent";
import { useWorkspaceStore } from "@/store/workspace";

export default function AgentEditorPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";

  // Read the store here (not inside the editor) so the editor stays a
  // pure controlled component — list-state upkeep is the route's
  // responsibility, mirroring the existing onBack/onSaved pattern.
  const { builtinAgents, mergeBuiltinAgents, upsertBuiltinAgents } =
    useWorkspaceStore();

  // Back / Save / Create / Delete all return to the section index
  // (`/agent`) rather than home. The section index keeps the agent
  // panel open and shows the Welcome card in the center, giving the
  // user an obvious "what's next" state while preserving the work
  // context. Returning to `/` would also collapse the panel — see
  // ThreePanelContent's pathname-driven render rule.
  return (
    <BuiltinAgentEditor
      agentId={isNew ? null : id}
      onBack={() => router.push("/agent")}
      // The editor returns the saved/created row; upsert it so the left
      // panel list reflects the change without a full reload (panel data
      // only loads on mount).
      onSaved={(row: BuiltinAgentRow) => {
        upsertBuiltinAgents([row]);
        router.push("/agent");
      }}
      onCreated={(row: BuiltinAgentRow) => {
        upsertBuiltinAgents([row]);
        router.push("/agent");
      }}
      onDeleted={(deletedId) => {
        // Drop the agent from the in-memory list so the left panel
        // reflects the deletion without a page reload.
        mergeBuiltinAgents(builtinAgents.filter((a) => a.id !== deletedId));
        router.push("/agent");
      }}
    />
  );
}
