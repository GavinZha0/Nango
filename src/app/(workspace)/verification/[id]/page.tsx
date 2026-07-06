"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export default function OldVerificationSuitePage(): ReactNode {
  const router = useRouter();
  useEffect(() => {
    router.replace("/verification");
  }, [router]);

  return (
    <div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
      <p>Redirecting…</p>
    </div>
  );
}
