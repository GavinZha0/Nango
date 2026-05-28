import { requireEditor } from "@/lib/auth/route-guards";

export default async function McpLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  await requireEditor();
  return <>{children}</>;
}
