import "server-only";

import { type ReactNode } from "react";
import { requireEditor } from "@/lib/auth/route-guards";

export default async function KbLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  await requireEditor();
  return <>{children}</>;
}
