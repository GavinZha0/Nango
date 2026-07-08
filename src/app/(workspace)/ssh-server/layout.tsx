import "server-only";

import { type ReactNode } from "react";
import { requireEditor } from "@/lib/auth/route-guards";

export default async function SshServerLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireEditor();
  return <>{children}</>;
}
