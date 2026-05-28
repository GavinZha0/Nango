import type { ReactNode } from "react";
import { UserManagement } from "@/components/admin/UserManagement";
import { Users } from "lucide-react";

export const metadata = { title: "User — Nango" };

export default function AdminUserPage(): ReactNode {
  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-bold tracking-tight">User</h1>
          <p className="text-sm text-muted-foreground">
            Create and manage users, roles, and access.
          </p>
        </div>
      </div>
      <UserManagement />
    </div>
  );
}
