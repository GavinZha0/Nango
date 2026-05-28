import { requireAdmin } from "@/lib/auth/route-guards";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  await requireAdmin();
  return <>{children}</>;
}
