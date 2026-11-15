"use client";

import { useMemo } from "react";
import { useRole } from "@/hooks/useRole";
import { authClient } from "@/lib/auth/client";

export interface ClientResource {
  visibility: "private" | "public" | string;
  createdBy: string | null;
}

export interface ResourcePermissions {
  canEdit: boolean;
  canDelete: boolean;
  canChangeVisibility: boolean;
  canToggleEnabled: boolean;
  loading: boolean;
}

/**
 * Client-side unified resource permission evaluation hook.
 * Accepts an object containing creator and visibility, returning four permission booleans.
 */
export function useResourcePermissions(resource: ClientResource | null | undefined): ResourcePermissions {
  const { isEditor, isAdmin, loading: roleLoading } = useRole();
  const session = authClient.useSession();
  
  const currentUserId = session.data?.user.id ?? null;
  const sessionLoading = session.isPending;
  const loading = roleLoading || sessionLoading;

  return useMemo(() => {
    // Default to no permissions
    if (loading || !resource || !currentUserId) {
      return {
        canEdit: false,
        canDelete: false,
        canChangeVisibility: false,
        canToggleEnabled: false,
        loading,
      };
    }

    const isOwner = resource.createdBy === currentUserId;

    // 1. Edit permission: Admin, resource creator, or public resource with Editor role
    const canEdit = isAdmin || isOwner || (resource.visibility === "public" && isEditor);

    // 2. Delete permission: Admin or resource creator
    const canDelete = isAdmin || isOwner;

    // 3. Visibility and enable-toggle permissions: match delete permission
    const canChangeVisibility = canDelete;
    const canToggleEnabled = canDelete;

    return {
      canEdit,
      canDelete,
      canChangeVisibility,
      canToggleEnabled,
      loading: false,
    };
  }, [resource, currentUserId, isAdmin, isEditor, loading]);
}
