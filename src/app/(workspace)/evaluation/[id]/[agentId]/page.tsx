"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EvaluationEditor } from "@/components/main-panels/EvaluationEditor";
import { useEvaluationStore, evalActions, agentKey } from "@/store/evaluation";

/**
 * /evaluation/[credentialId]/[agentId] — backend agent evaluation editor.
 *
 * Two URL segments disambiguate from the builtin route (/evaluation/[id])
 * which has only one segment.
 */
export default function BackendEvaluationEditorPage(): ReactNode {
  const router = useRouter();
  const { id, agentId } = useParams<{
    id: string;
    agentId: string;
  }>();
  const decodedAgentId = decodeURIComponent(agentId);
  const decodedCredentialId = decodeURIComponent(id);

  const suitesLoaded = useEvaluationStore(
    (s) => s.suitesLoaded[agentKey(decodedAgentId, "backend")] ?? false,
  );
  const loading = useEvaluationStore((s) => s.loading);

  useEffect(() => {
    if (!suitesLoaded) void evalActions.refreshSuites(decodedAgentId, "backend");
  }, [decodedAgentId, suitesLoaded]);

  if (!suitesLoaded || loading) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <EvaluationEditor
      key={`${decodedCredentialId}:${decodedAgentId}`}
      agentId={decodedAgentId}
      agentSource="backend"
      credentialId={decodedCredentialId}
      onBack={() => router.push("/evaluation")}
    />
  );
}
