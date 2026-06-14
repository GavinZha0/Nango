import type { ReactNode } from "react";
import { CredentialManagement } from "@/components/admin/CredentialManagement";

export default function AdminCredentialPage(): ReactNode {
  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <CredentialManagement />
    </div>
  );
}
