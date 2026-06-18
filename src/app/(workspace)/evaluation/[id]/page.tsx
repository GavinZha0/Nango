"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EvaluationEditor } from "@/components/main-panels/EvaluationEditor";
import { useEvaluationStore, evalActions, agentKey } from "@/store/evaluation";

export default function EvaluationEditorPage(): ReactNode {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const suitesLoaded = useEvaluationStore(
    (s) => s.suitesLoaded[agentKey(id, "builtin")] ?? false,
  );
  const loading = useEvaluationStore((s) => s.loading);

  useEffect(() => {
    if (!suitesLoaded) void evalActions.refreshSuites(id, "builtin");
  }, [id, suitesLoaded]);

  if (!suitesLoaded || loading) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <EvaluationEditor
      key={id}
      agentId={id}
      agentSource="builtin"
      onBack={() => router.push("/evaluation")}
    />
  );
}
