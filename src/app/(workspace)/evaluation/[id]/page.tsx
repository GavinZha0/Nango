"use client";

import { type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { EvaluationSuiteEditor } from "@/components/main-panels/evaluation/EvaluationSuiteEditor";

/**
 * /evaluation/[id] — Evaluation Suite Editor for a specific eval suite.
 */
export default function EvaluationSuitePage(): ReactNode {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  if (!id) {
    return (
      <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
        <p>Invalid suite ID.</p>
      </div>
    );
  }

  return (
    <EvaluationSuiteEditor
      suiteId={id}
      onBack={() => router.push("/evaluation")}
    />
  );
}
