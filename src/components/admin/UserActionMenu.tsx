"use client";

import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Shield, Ban, ShieldCheck, LogOut, Trash2 } from "lucide-react";

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  banned?: boolean | null;
}

interface UserActionMenuProps {
  user: UserRow;
  onRefresh: () => void;
}

type PendingAction = "ban" | "unban" | "revoke" | "delete" | null;
type Role = "admin" | "editor" | "user";
const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  editor: "Editor",
  user: "User",
};

interface AdminActionResponse {
  error?: { message?: string } | null;
}

function resolveResponseErrorMessage(
  response: AdminActionResponse,
  fallbackMessage: string,
): string | null {
  return response.error?.message ?? (response.error ? fallbackMessage : null);
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function UserActionMenu({ user, onRefresh }: UserActionMenuProps): ReactNode {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string>("");

  const isBanned = Boolean(user.banned);
  const currentRole = user.role as Role;

  async function confirm(): Promise<void> {
    if (!pendingAction) return;

    setActionError("");
    setWorking(true);
    try {
      if (pendingAction === "delete") {
        // Custom soft-delete endpoint (see docs/rbac.md) — bypasses
        // better-auth's hard removeUser.
        const res = await fetch(`/api/admin/users/${user.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          setActionError(await readErrorMessage(res, "Failed to delete user"));
          return;
        }
      } else {
        let response: AdminActionResponse;
        switch (pendingAction) {
          case "ban":
            response = await authClient.admin.banUser({ userId: user.id });
            break;
          case "unban":
            response = await authClient.admin.unbanUser({ userId: user.id });
            break;
          case "revoke":
            response = await authClient.admin.revokeUserSessions({ userId: user.id });
            break;
        }
        const fallbackMessage = `Failed to ${pendingAction} user`;
        const responseError = resolveResponseErrorMessage(response, fallbackMessage);
        if (responseError) {
          setActionError(responseError);
          return;
        }
      }

      setPendingAction(null);
      onRefresh();
    } catch {
      setActionError("Unexpected error while performing admin action");
    } finally {
      setWorking(false);
    }
  }

  async function setRole(role: Role): Promise<void> {
    if (role === currentRole) return;
    setActionError("");
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        setActionError(await readErrorMessage(res, "Failed to update role"));
        return;
      }
    } catch {
      setActionError("Unexpected error while updating role");
      return;
    }
    onRefresh();
  }

  const ACTION_LABELS: Record<NonNullable<PendingAction>, string> = {
    ban: "Ban user",
    unban: "Unban user",
    revoke: "Revoke all sessions",
    delete: "Delete user",
  };

  const ACTION_DESCRIPTIONS: Record<NonNullable<PendingAction>, string> = {
    ban: `Ban ${user.name}? They will be unable to sign in until unbanned.`,
    unban: `Unban ${user.name}? They will be able to sign in again.`,
    revoke: `Sign out ${user.name} from all active sessions?`,
    delete: `Delete ${user.name} (${user.email})? They will be signed out immediately and lose access to the app. Their resources are preserved (creator marked as deleted) and the email becomes available for re-use.`,
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Actions</span>
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Set role
          </DropdownMenuLabel>
          {(["admin", "editor", "user"] as const).map((role) => (
            <DropdownMenuItem
              key={role}
              onClick={() => setRole(role)}
              disabled={role === currentRole}
            >
              <Shield className="h-4 w-4" />
              {ROLE_LABEL[role]}
              {role === currentRole ? " (current)" : ""}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {isBanned ? (
            <DropdownMenuItem onClick={() => { setActionError(""); setPendingAction("unban"); }}>
              <ShieldCheck className="h-4 w-4" />
              Unban
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => { setActionError(""); setPendingAction("ban"); }}>
              <Ban className="h-4 w-4" />
              Ban
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => { setActionError(""); setPendingAction("revoke"); }}>
            <LogOut className="h-4 w-4" />
            Revoke Sessions
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => { setActionError(""); setPendingAction("delete"); }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
          {actionError ? (
            <p className="px-2 py-1 text-xs text-destructive">{actionError}</p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingAction(null);
            setActionError("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingAction ? ACTION_LABELS[pendingAction] : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction ? ACTION_DESCRIPTIONS[pendingAction] : ""}
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
    </>
  );
}
