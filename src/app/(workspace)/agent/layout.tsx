import { requireEditor } from "@/lib/auth/route-guards";

export default async function AgentLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  await requireEditor();
  return <>{children}</>;
}
