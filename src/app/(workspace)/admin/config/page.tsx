import type { ReactNode } from "react";
import { ConfigManagement } from "@/components/admin/ConfigManagement";

export const metadata = { title: "Config — Nango" };

export default function AdminConfigPage(): ReactNode {
  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <ConfigManagement />
    </div>
  );
}
