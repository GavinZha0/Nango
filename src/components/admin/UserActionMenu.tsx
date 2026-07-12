"use client";

import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LogOut, Trash2, KeyRound } from "lucide-react";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  org?: string | null;
  banned?: boolean | null;
  lastActiveAt?: string | null;
}

type Role = "admin" | "editor" | "user";
const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  editor: "Editor",
  user: "User",
};

interface AdminActionResponse {
  error?: { message?: string } | null;
}

function resolveErrorMessage(
  response: AdminActionResponse,
  fallback: string,
): string | null {
  return response.error?.message ?? (response.error ? fallback : null);
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// RoleBadge — clickable badge that opens a dropdown to switch roles
// ---------------------------------------------------------------------------

interface RoleBadgeProps {
  user: UserRow;
  onRefresh: () => void;
}

export function RoleBadge({ user, onRefresh }: RoleBadgeProps): ReactNode {
  const currentRole = user.role as Role;

  async function setRole(role: Role): Promise<void> {
    if (role === currentRole) return;
    const res = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (res.ok) onRefresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className="cursor-pointer">
            <Badge
              variant={currentRole === "admin" ? "default" : "secondary"}
              className="cursor-pointer transition-opacity hover:opacity-80"
            >
              {ROLE_LABEL[currentRole] ?? currentRole}
            </Badge>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-36">
        <DropdownMenuGroup>
          {(["admin", "editor", "user"] as const).map((role) => (
            <DropdownMenuItem
              key={role}
              onClick={() => void setRole(role)}
              disabled={role === currentRole}
            >
              {ROLE_LABEL[role]}
              {role === currentRole ? " (current)" : ""}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge — clickable badge that toggles Active / Banned
// ---------------------------------------------------------------------------

interface StatusBadgeProps {
  user: UserRow;
  onRefresh: () => void;
}

export function StatusBadge({ user, onRefresh }: StatusBadgeProps): ReactNode {
  const [toggling, setToggling] = useState(false);
  const isActive = !user.banned;

  async function toggle(): Promise<void> {
    setToggling(true);
    const response: AdminActionResponse = isActive
      ? await authClient.admin.banUser({ userId: user.id })
      : await authClient.admin.unbanUser({ userId: user.id });
    setToggling(false);
    const err = resolveErrorMessage(response, `Failed to ${isActive ? "ban" : "unban"} user`);
    if (!err) onRefresh();
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="cursor-pointer"
            onClick={() => void toggle()}
            disabled={toggling}
          >
            <Badge
              variant={isActive ? "outline" : "destructive"}
              className="cursor-pointer transition-opacity hover:opacity-80"
            >
              {toggling ? "…" : isActive ? "Active" : "Banned"}
            </Badge>
          </button>
        }
      />
      <TooltipContent>
        {isActive ? "Click to ban" : "Click to unban"}
      </TooltipContent>
    </Tooltip>
  );
}


// ---------------------------------------------------------------------------
// UserActions — Revoke Sessions + Delete + Reset Password buttons (with confirmation)
// ---------------------------------------------------------------------------

interface UserActionsProps {
  user: UserRow;
  onRefresh: () => void;
}

type PendingAction = "revoke" | "delete" | "reset_password" | null;

export function UserActions({ user, onRefresh }: UserActionsProps): ReactNode {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [tempPassword, setTempPassword] = useState("");
  const [successDialogOpen, setSuccessDialogOpen] = useState(false);

  async function confirm(): Promise<void> {
    if (!pendingAction) return;
    setActionError("");
    setWorking(true);
    try {
      if (pendingAction === "delete") {
        const res = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
        if (!res.ok) {
          setActionError(await readErrorMessage(res, "Failed to delete user"));
          return;
        }
        setPendingAction(null);
        onRefresh();
      } else if (pendingAction === "reset_password") {
        const res = await fetch(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resetPassword: true }),
        });
        if (!res.ok) {
          setActionError(await readErrorMessage(res, "Failed to reset password"));
          return;
        }
        const data = (await res.json()) as { tempPassword?: string };
        if (data.tempPassword) {
          setTempPassword(data.tempPassword);
          setSuccessDialogOpen(true);
        } else {
          onRefresh();
        }
        setPendingAction(null);
      } else {
        const response: AdminActionResponse =
          await authClient.admin.revokeUserSessions({ userId: user.id });
        const err = resolveErrorMessage(response, "Failed to revoke sessions");
        if (err) { setActionError(err); return; }
        setPendingAction(null);
        onRefresh();
      }
    } catch {
      setActionError("Unexpected error");
    } finally {
      setWorking(false);
    }
  }

  const labels: Record<NonNullable<PendingAction>, string> = {
    revoke: "Revoke all sessions",
    delete: "Delete user",
    reset_password: "Reset user password",
  };

  const descriptions: Record<NonNullable<PendingAction>, string> = {
    revoke: `Sign out ${user.name} from all active sessions?`,
    delete: `Delete ${user.name} (${user.email})? They will be signed out immediately and lose access. Resources are preserved and the email becomes available for re-use.`,
    reset_password: `Generate a temporary password for ${user.name}? This will invalidate their current password. They will be forced to change it on their next login.`,
  };

  return (
    <>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => { setActionError(""); setPendingAction("revoke"); }}
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="sr-only">Revoke Sessions</span>
              </Button>
            }
          />
          <TooltipContent>Revoke Sessions</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => { setActionError(""); setPendingAction("reset_password"); }}
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span className="sr-only">Reset Password</span>
              </Button>
            }
          />
          <TooltipContent>Reset Password</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-destructive hover:text-destructive"
                onClick={() => { setActionError(""); setPendingAction("delete"); }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="sr-only">Delete</span>
              </Button>
            }
          />
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) { setPendingAction(null); setActionError(""); }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingAction ? labels[pendingAction] : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction ? descriptions[pendingAction] : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirm}
              disabled={working}
              className={pendingAction === "delete" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            >
              {working ? "Working…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={successDialogOpen}
        onOpenChange={(open) => {
          if (!open) { setSuccessDialogOpen(false); setTempPassword(""); onRefresh(); }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Password Reset Successfully</AlertDialogTitle>
            <AlertDialogDescription>
              A temporary password has been generated for <strong>{user.name}</strong>. 
              Please copy and send it to the user. They will be forced to change it upon login:
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="my-4 flex items-center justify-between gap-2 rounded bg-muted p-3 font-mono text-lg text-foreground">
            <span className="select-all tracking-wider">{tempPassword}</span>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(tempPassword);
              }}
            >
              Copy
            </Button>
          </div>
          
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => { setSuccessDialogOpen(false); setTempPassword(""); onRefresh(); }}>
              Done
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
