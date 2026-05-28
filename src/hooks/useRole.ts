"use client";

import { authClient } from "@/lib/auth/client";

export type UserRole = "admin" | "editor" | "user";

interface UseRoleResult {
  role: UserRole;
  loading: boolean;
  authenticated: boolean;
  isAdmin: boolean;
  isEditor: boolean;
}

export function useRole(): UseRoleResult {
  const session = authClient.useSession();
  const loading = session.isPending;
  const data = session.data;
  const role = (data?.user.role ?? "user") as UserRole;
  const authenticated = !loading && !!data;

  return {
    role,
    loading,
    authenticated,
    isAdmin: role === "admin",
    isEditor: role === "admin" || role === "editor",
  };
}
