"use client";

import { useState, type ReactNode } from "react";
import { UserManagement } from "@/components/admin/UserManagement";
import { LoginEvents } from "@/components/admin/LoginEvents";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = "users" | "login-events";

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function TabButton({ label, active, onClick }: TabButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

export default function AdminUserPage(): ReactNode {
  const [tab, setTab] = useState<Tab>("users");

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-bold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            Manage users, roles, access, and login activity.
          </p>
        </div>
      </div>

      <div className="flex border-b">
        <TabButton label="User Accounts" active={tab === "users"} onClick={() => setTab("users")} />
        <TabButton label="Login Events" active={tab === "login-events"} onClick={() => setTab("login-events")} />
      </div>

      {tab === "users" ? <UserManagement /> : <LoginEvents />}
    </div>
  );
}
