"use client";

import { useState, type ReactNode } from "react";
import { UserManagement } from "@/components/admin/UserManagement";
import { LoginEvents } from "@/components/admin/LoginEvents";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList className="h-8">
              <TabsTrigger value="users" className="text-xs">User Accounts</TabsTrigger>
              <TabsTrigger value="login-events" className="text-xs">Login Events</TabsTrigger>
            </TabsList>
          </Tabs>
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

