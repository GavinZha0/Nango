import "server-only";

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable, SshServerTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";
import { parseBody } from "@/lib/http/validation";
import { loadSshAuth } from "@/lib/ssh/auth-loader";
import { verifyConnection } from "@/lib/ssh/client";
import { createSshServerSchema } from "@/lib/ssh/validation";

const ROUTE = "/api/ssh-servers";

// GET /api/ssh-servers
// Visibility-aware list: own rows + public rows for non-admins;
// everything for admins. Used by SshServerPanel and by the agent
// editor's "bind SSH hosts" picker. The credential's encrypted
// payload is never returned — only `credentialId` so the editor can
// resolve the credential's display name out of band.

export const GET = withSession(ROUTE, async ({ session }) => {
  const rows = await db
    .select()
    .from(SshServerTable)
    .where(
      visibilitySql(
        session,
        SshServerTable.visibility,
        SshServerTable.createdBy,
      ),
    )
    .orderBy(desc(SshServerTable.createdAt));

  return NextResponse.json(rows);
});

// POST /api/ssh-servers
// Editor+ only. Validates that the bound credential exists, is
// enabled, AND carries an SSH-compatible auth shape (`type` in
// `basic_auth` or `private_key`). Cross-check here so the editor sees
// a clear error at row creation rather than at first connect.

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSshServerSchema);

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
        "SSH expects basic_auth ({username, password}) or private_key " +
        "({username, privateKey, passphrase?}).",
    );
  }

  // Auto-verify when the form omitted the fingerprint. Admin clicked
  // Save without first clicking "Verify connection" — we run the
  // same one-round-trip verify (host capture + auth) here. Auth
  // failure rejects the save (we don't persist an unreachable row).
  // SECURITY: this is a TOFU-equivalent path; admin RBAC + the
  // explicit "click Save" act as the human-in-the-loop trust anchor.
  let pinnedFingerprint: string;
  if (body.knownHostFingerprint) {
    pinnedFingerprint = body.knownHostFingerprint;
  } else {
    const auth = await loadSshAuth(body.credentialId);
    if (!auth) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        `Credential ${body.credentialId} could not be loaded for ` +
          "auto-verify (decrypt failed or wrong type).",
      );
    }
    const result = await verifyConnection(
      {
        host: body.host,
        port: body.port ?? 22,
        knownHostFingerprint: null,
      },
      auth,
    );
    if (!result.ok || !result.fingerprint) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        `Auto-verify failed (${result.error?.code ?? "UNKNOWN"}): ` +
          `${result.error?.message ?? "Unable to verify SSH host."}`,
      );
    }
    pinnedFingerprint = result.fingerprint;
  }

  const [row] = await db
    .insert(SshServerTable)
    .values({
      name: body.name,
      description: body.description ?? null,
      credentialId: body.credentialId,
      host: body.host,
      port: body.port ?? 22,
      knownHostFingerprint: pinnedFingerprint,
      commandAllow: body.commandAllow ?? null,
      commandDeny: body.commandDeny ?? [],
      loginShell: body.loginShell ?? true,
      enabled: body.enabled ?? true,
      visibility: body.visibility ?? "private",
      createdBy: session.user.id,
      updatedBy: session.user.id,
    })
    .returning();

  return NextResponse.json(row, { status: 201 });
});
