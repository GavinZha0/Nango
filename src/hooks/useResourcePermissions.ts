"use client";

import { useMemo } from "react";
import { useRole } from "@/hooks/useRole";
import { authClient } from "@/lib/auth/client";

export interface ClientResource {
  source?: "builtin" | "local" | string;
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
 * 客户端统一资源权限评估 Hook
 * 接收一个包含创建人、可见性、来源的对象，返回四个维度的控制布尔值
 */
export function useResourcePermissions(resource: ClientResource | null | undefined): ResourcePermissions {
  const { isEditor, isAdmin, loading: roleLoading } = useRole();
  const session = authClient.useSession();
  
  const currentUserId = session.data?.user.id ?? null;
  const sessionLoading = session.isPending;
  const loading = roleLoading || sessionLoading;

  return useMemo(() => {
    // 默认无任何权限
    if (loading || !resource || !currentUserId) {
      return {
        canEdit: false,
        canDelete: false,
        canChangeVisibility: false,
        canToggleEnabled: false,
        loading,
      };
    }

    const isBuiltin = resource.source === "builtin";
    const isOwner = resource.createdBy === currentUserId;

    // 1. 编辑权限：非内置资源 && (Admin 或者是该资源创建者 || 该资源为 Public && 具备 Editor 角色)
    const canEdit = !isBuiltin && (isAdmin || isOwner || (resource.visibility === "public" && isEditor));

    // 2. 删除权限：非内置资源 && (Admin 或者是资源创建者)
    const canDelete = !isBuiltin && (isAdmin || isOwner);

    // 3. 可见性修改与启用切换：与删除权限一致
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
