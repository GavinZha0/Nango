import "server-only";

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  CredentialTable,
  BuiltinAgentTable,
  McpServerTable,
  CREDENTIAL_SERVICE_TYPES,
} from "@/lib/db/schema";
import { encrypt, extractKeyPreview } from "@/lib/credentials/crypto";
import { invalidateForCredentialChange } from "@/lib/cache/invalidation";
import { ApiError, withAdmin } from "@/lib/http/route-handlers";
import {
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
} from "@/lib/http/validation";

const ROUTE = "/api/admin/credentials/[id]";

// PATCH /api/admin/credentials/[id]

const credentialServiceTypeEnum = z.enum(CREDENTIAL_SERVICE_TYPES);

const updateSchema = z
  .object({
    name: nonEmptyString.optional(),
    serviceType: credentialServiceTypeEnum.optional(),
    provider: optionalTrimmedString.optional(),
    restUrl: optionalTrimmedString.optional(),
    aguiUrl: optionalTrimmedString.optional(),
    enabled: z.boolean().optional(),
    /** If provided, the payload is re-encrypted and keyPreview is refreshed. */
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const PATCH = withAdmin<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const { id } = params;
    const body = await parseBody(req, updateSchema);

    // Build the update object with only provided fields. updatedBy
    // tracks the admin who last touched this credential (multi-admin
    // deployments). See docs/rbac.md.
    const updates: Partial<typeof CredentialTable.$inferInsert> = {
      updatedAt: new Date(),
      updatedBy: session.user.id,
    };

    if (body.name !== undefined) updates.name = body.name;
    if (body.serviceType !== undefined) updates.serviceType = body.serviceType;
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.restUrl !== undefined) updates.restUrl = body.restUrl;
    if (body.aguiUrl !== undefined) updates.aguiUrl = body.aguiUrl;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    if (body.payload) {
      updates.encryptedPayload = encrypt(body.payload);
      updates.metadata = { keyPreview: extractKeyPreview(body.payload) };
    }

    const [row] = await db
      .update(CredentialTable)
      .set(updates)
      .where(eq(CredentialTable.id, id))
      .returning({
        id: CredentialTable.id,
        name: CredentialTable.name,
        type: CredentialTable.type,
        serviceType: CredentialTable.serviceType,
        provider: CredentialTable.provider,
        restUrl: CredentialTable.restUrl,
        aguiUrl: CredentialTable.aguiUrl,
        metadata: CredentialTable.metadata,
        enabled: CredentialTable.enabled,
        createdAt: CredentialTable.createdAt,
        updatedAt: CredentialTable.updatedAt,
      });

    if (!row) {
      throw new ApiError("NOT_FOUND", 404, "Credential not found.");
    }

    // Credential payload or enabled-state changes can affect builtin agent
    // runtimes — drop only the AgentSpec / MCP entries that reference this
    // credential, not the whole world.
    await invalidateForCredentialChange(id);

    return NextResponse.json(row);
  },
);

// DELETE /api/admin/credentials/[id]

export const DELETE = withAdmin<{ id: string }>(
  ROUTE,
  async ({ params }) => {
    const { id } = params;

    // Check every table that references this credential. We surface a single
    // 409 with a per-table breakdown so the admin can see exactly what depends
    // on the credential before deleting.
    //
    // FK behaviour:
    //   - builtin_agent.credential_id  : NOT NULL, no cascade  (deletion would
    //                                    fail at the DB level — we block it
    //                                    explicitly with a friendly message).
    //   - mcp_server.credential_id     : SET NULL on delete    (would silently
    //                                    detach auth — we block it explicitly).
    const [agentUsage, mcpUsage] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(BuiltinAgentTable)
        .where(eq(BuiltinAgentTable.credentialId, id))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(McpServerTable)
        .where(eq(McpServerTable.credentialId, id))
        .then((r) => r[0]?.count ?? 0),
    ]);

    const usages: Array<{ resource: string; count: number; label: string }> = [];
    if (agentUsage > 0) {
      usages.push({ resource: "builtin_agent", count: agentUsage, label: "built-in agent(s)" });
    }
    if (mcpUsage > 0) {
      usages.push({ resource: "mcp_server", count: mcpUsage, label: "MCP server(s)" });
    }

    if (usages.length > 0) {
      const summary = usages.map((u) => `${u.count} ${u.label}`).join(", ");
      // 409 CONFLICT carries the per-table breakdown in `details.usages`
      // so the admin UI can render exactly what depends on the credential.
      throw new ApiError(
        "CONFLICT",
        409,
        `This credential is in use by ${summary}. Remove or reassign them before deleting.`,
        { usages },
      );
    }

    const [deleted] = await db
      .delete(CredentialTable)
      .where(eq(CredentialTable.id, id))
      .returning({ id: CredentialTable.id });

    if (!deleted) {
      throw new ApiError("NOT_FOUND", 404, "Credential not found.");
    }

    await invalidateForCredentialChange(id);

    return new NextResponse(null, { status: 204 });
  },
);
