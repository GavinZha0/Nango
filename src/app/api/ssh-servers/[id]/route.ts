import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable, SshServerTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
  canViewResource,
} from "@/lib/auth/permissions";
import { parseBody } from "@/lib/http/validation";
import { invalidateForSshServerChange } from "@/lib/cache/invalidation";
import { updateSshServerSchema } from "@/lib/ssh/validation";

const ROUTE = "/api/ssh-servers/[id]";

// GET /api/ssh-servers/[id]

export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = params;
    const [row] = await db
      .select()
      .from(SshServerTable)
      .where(eq(SshServerTable.id, id))
      .limit(1);
    if (!row) {
      throw new ApiError("NOT_FOUND", 404, "SSH server not found.");
    }
    if (
      !canViewResource(
        {
          source: undefined,
          visibility: row.visibility as "private" | "public",
          createdBy: row.createdBy,
        },
        session,
      )
    ) {
      // Same status as not-found so we don't leak existence to a
      // user who can't see the row.
      throw new ApiError("NOT_FOUND", 404, "SSH server not found.");
    }
    return NextResponse.json(row);
  },
);

// PATCH /api/ssh-servers/[id]
// Mirrors the data-source pattern: split content edits (anyone in
// editor role with public/own access) from visibility / enabled
// (creator or admin). `name` cannot be patched — see validation.ts.

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const { id } = params;
    const [existing] = await db
      .select({
        id: SshServerTable.id,
        createdBy: SshServerTable.createdBy,
        visibility: SshServerTable.visibility,
      })
      .from(SshServerTable)
      .where(eq(SshServerTable.id, id))
      .limit(1);
    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "SSH server not found.");
    }

    const body = await parseBody(req, updateSshServerSchema);

    const rbac = {
      visibility: existing.visibility as "private" | "public",
      createdBy: existing.createdBy,
    };

    const editsContent =
      body.description !== undefined
      || body.credentialId !== undefined
      || body.host !== undefined
      || body.port !== undefined
      || body.knownHostFingerprint !== undefined
      || body.commandAllow !== undefined
      || body.commandApprove !== undefined
      || body.commandDeny !== undefined
      || body.loginShell !== undefined;
    if (editsContent && !canEditResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot edit this SSH server.",
      );
    }
    if (
      (body.visibility !== undefined || body.enabled !== undefined) &&
      !canChangeVisibility(rbac, session)
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can change visibility / enabled.",
      );
    }

    // Re-validate credential when caller swaps it: must exist, be
    // enabled, and have the SSH shape.
    if (body.credentialId !== undefined) {
      const [cred] = await db
        .select({
          id: CredentialTable.id,
          enabled: CredentialTable.enabled,
          type: CredentialTable.type,
        })
        .from(CredentialTable)
        .where(eq(CredentialTable.id, body.credentialId))
        .limit(1);
      if (!cred) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          `Credential ${body.credentialId} not found.`,
        );
      }
      if (!cred.enabled) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          `Credential ${body.credentialId} is disabled.`,
        );
      }
      if (cred.type !== "basic_auth" && cred.type !== "private_key") {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          `Credential ${body.credentialId} has type=${cred.type}; ` +
            "SSH expects basic_auth ({username, password}) or " +
            "private_key ({username, privateKey, passphrase?}).",
        );
      }
    }

    const updates: Partial<typeof SshServerTable.$inferInsert> = {
      updatedAt: new Date(),
      updatedBy: session.user.id,
    };
    if (body.description !== undefined) updates.description = body.description;
    if (body.credentialId !== undefined) updates.credentialId = body.credentialId;
    if (body.host !== undefined) updates.host = body.host;
    if (body.port !== undefined) updates.port = body.port;
    if (body.knownHostFingerprint !== undefined) {
      updates.knownHostFingerprint = body.knownHostFingerprint;
    }
    if (body.commandAllow !== undefined) updates.commandAllow = body.commandAllow;
    if (body.commandApprove !== undefined) updates.commandApprove = body.commandApprove;
    if (body.commandDeny !== undefined) updates.commandDeny = body.commandDeny;
    if (body.loginShell !== undefined) updates.loginShell = body.loginShell;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.visibility !== undefined) updates.visibility = body.visibility;

    const [row] = await db
      .update(SshServerTable)
      .set(updates)
      .where(eq(SshServerTable.id, id))
      .returning();

    // Any field change might affect what an agent sees — connection,
    // policy, enabled, or description (which appears in the injected
    // prompt block). Evict bound agents' cached specs.
    await invalidateForSshServerChange(id);

    return NextResponse.json(row);
  },
);

// DELETE /api/ssh-servers/[id]

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = params;
    const [existing] = await db
      .select({
        id: SshServerTable.id,
        createdBy: SshServerTable.createdBy,
        visibility: SshServerTable.visibility,
      })
      .from(SshServerTable)
      .where(eq(SshServerTable.id, id))
      .limit(1);
    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "SSH server not found.");
    }
    if (
      !canDeleteResource(
        {
          visibility: existing.visibility as "private" | "public",
          createdBy: existing.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this SSH server.",
      );
    }

    // Order matters: invalidate first so reverse-lookup still finds
    // the row; the SET-NULL FK on builtin_agent_tool will null out
    // the binding column when the row goes away.
    await invalidateForSshServerChange(id);
    await db.delete(SshServerTable).where(eq(SshServerTable.id, id));

    return new NextResponse(null, { status: 204 });
  },
);
