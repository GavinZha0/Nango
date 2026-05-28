"use client";

import { useRouter, useParams } from "next/navigation";
import { BuiltinAgentEditor } from "@/components/main-panels/BuiltinAgentEditor";
import { useWorkspaceStore } from "@/store/workspace";

export default function AgentEditorPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";

  // Read the store here (not inside the editor) so the editor stays a
  // pure controlled component — list-state cleanup is the route's
  // responsibility, mirroring the existing onBack/onSaved pattern.
  const { builtinAgents, mergeBuiltinAgents } = useWorkspaceStore();

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
      onSaved={() => router.push("/agent")}
      onCreated={() => router.push("/agent")}
      onDeleted={(deletedId) => {
        // Drop the agent from the in-memory list so the left panel
        // reflects the deletion without a page reload.
        mergeBuiltinAgents(builtinAgents.filter((a) => a.id !== deletedId));
        router.push("/agent");
      }}
    />
  );
}
