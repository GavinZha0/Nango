"use client";

import { useState, type ReactNode } from "react";
import { UserManagement } from "@/components/admin/UserManagement";
import { LoginEvents } from "@/components/admin/LoginEvents";
import { Button } from "@/components/ui/button";
import { Users, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = "users" | "login-events";

export default function AdminUserPage(): ReactNode {
  const [tab, setTab] = useState<Tab>("users");
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      {/* Integrated Single-row Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <Users className="h-6 w-6 text-muted-foreground" />
            <h1 className="text-xl font-bold tracking-tight">Users</h1>
          </div>

          <div className="flex items-center rounded-full border border-border bg-muted p-0.5 shadow-sm">
            <button
              onClick={() => setTab("users")}
              className={cn(
                "rounded-full px-4 py-1 text-sm font-medium transition-colors",
                tab === "users"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              User Accounts
            </button>
            <button
              onClick={() => setTab("login-events")}
              className={cn(
                "rounded-full px-4 py-1 text-sm font-medium transition-colors",
                tab === "login-events"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Login Events
            </button>
          </div>
        </div>

        {tab === "users" && (
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <UserPlus className="h-4 w-4" />
            New User
          </Button>
        )}
      </div>

      <div className={cn(tab !== "users" && "hidden")}>
        <UserManagement createOpen={createOpen} onOpenChange={setCreateOpen} />
      </div>
      <div className={cn(tab !== "login-events" && "hidden")}>
        <LoginEvents />
      </div>
    </div>
  );
}
