import "server-only";

import { NextResponse } from "next/server";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { UserTable, SessionTable } from "@/lib/db/schema";
import { ApiError, withAdmin } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { VALID_ROLES, type UserRole } from "@/lib/auth/permissions";
import { auth } from "@/lib/auth/auth-instance";
import { headers } from "next/headers";

const ROUTE = "/api/admin/users/[id]";

// PATCH /api/admin/users/[id]
// Currently only supports role change. Refuses to demote the last admin or
// change the caller's own role (admins can't lock themselves out).

const patchSchema = z
  .object({
    role: z.enum(VALID_ROLES as readonly [UserRole, ...UserRole[]]).optional(),
    resetPassword: z.boolean().optional(),
  })
  .strict();

function generateTempPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let pass = "";
  for (let i = 0; i < 12; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

export const PATCH = withAdmin<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const { id } = params;
    const body = await parseBody(req, patchSchema);
    const newRole = body.role;
    const shouldReset = body.resetPassword === true;

    if (id === session.user.id) {
      if (newRole !== undefined) {
        throw new ApiError(
          "CONFLICT",
          409,
          "Admins cannot change their own role. Ask another admin.",
        );
      }
      if (shouldReset) {
        throw new ApiError(
          "CONFLICT",
          409,
          "Admins cannot reset their own password this way. Use the Profile page.",
        );
      }
    }

    const [target] = await db
      .select({
        id: UserTable.id,
        role: UserTable.role,
        deletedAt: UserTable.deletedAt,
      })
      .from(UserTable)
      .where(eq(UserTable.id, id))
      .limit(1);

    if (!target || target.deletedAt !== null) {
      throw new ApiError("NOT_FOUND", 404, "User not found.");
    }

    // Demote-the-last-admin guard.
    if (newRole !== undefined && target.role === "admin" && newRole !== "admin") {
      const [{ remaining } = { remaining: 0 }] = await db
        .select({ remaining: count() })
        .from(UserTable)
        .where(
          and(
            eq(UserTable.role, "admin"),
            isNull(UserTable.deletedAt),
            ne(UserTable.id, id),
          ),
        );
      if (Number(remaining) === 0) {
        throw new ApiError(
          "CONFLICT",
          409,
          "Cannot demote the last remaining admin. Promote someone else first.",
        );
      }
    }

    let tempPassword: string | undefined = undefined;

    if (newRole !== undefined) {
      await db
        .update(UserTable)
        .set({ role: newRole, updatedAt: new Date() })
        .where(eq(UserTable.id, id));
    }

    if (shouldReset) {
      tempPassword = generateTempPassword();
      await auth.api.setUserPassword({
        body: {
          userId: id,
          newPassword: tempPassword,
        },
        headers: await headers(),
      });
      await db
        .update(UserTable)
        .set({ mustChangePassword: true, updatedAt: new Date() })
        .where(eq(UserTable.id, id));
    }

    return NextResponse.json({ id, role: newRole, tempPassword });
  },
);

// DELETE /api/admin/users/[id]
// Soft delete: set deleted_at + clear sessions. Email is freed for re-use
// via the partial unique index. See docs/rbac.md 
export const DELETE = withAdmin<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = params;

    if (id === session.user.id) {
      throw new ApiError(
        "CONFLICT",
        409,
        "Admins cannot delete their own account.",
      );
    }

    const [target] = await db
      .select({
        id: UserTable.id,
        role: UserTable.role,
        email: UserTable.email,
        deletedAt: UserTable.deletedAt,
      })
      .from(UserTable)
      .where(eq(UserTable.id, id))
      .limit(1);

    if (!target || target.deletedAt !== null) {
      throw new ApiError("NOT_FOUND", 404, "User not found.");
    }

    // Don't delete the last remaining admin.
    if (target.role === "admin") {
      const [{ remaining } = { remaining: 0 }] = await db
        .select({ remaining: count() })
        .from(UserTable)
        .where(
          and(
            eq(UserTable.role, "admin"),
            isNull(UserTable.deletedAt),
            ne(UserTable.id, id),
          ),
        );
      if (Number(remaining) === 0) {
        throw new ApiError(
          "CONFLICT",
          409,
          "Cannot delete the last remaining admin.",
        );
      }
    }

    await db.transaction(async (tx) => {
      const deletedEmail = `del_${id.slice(0, 8)}_${target.email}`;
      await tx
        .update(UserTable)
        .set({
          email: deletedEmail,
          deletedAt: new Date(),
          deletedBy: session.user.id,
          updatedAt: new Date(),
        })
        .where(eq(UserTable.id, id));
      // Drop all sessions so their existing cookies stop working.
      await tx.delete(SessionTable).where(eq(SessionTable.userId, id));
    });

    return new NextResponse(null, { status: 204 });
  },
);
