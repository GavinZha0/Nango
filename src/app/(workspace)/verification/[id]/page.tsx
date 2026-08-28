"use client";

import { type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { VerificationSuiteEditor } from "@/components/main-panels/VerificationSuiteEditor";

/**
 * /verification/[id] — Verification Suite Editor for a specific test suite.
 */
export default function VerificationSuitePage(): ReactNode {
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
    <VerificationSuiteEditor
      suiteId={id}
      onBack={() => router.push("/verification")}
    />
  );
}
