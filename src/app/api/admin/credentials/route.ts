import "server-only";

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  BuiltinAgentTable,
  CREDENTIAL_SERVICE_TYPES,
  CREDENTIAL_TYPES,
  CredentialTable,
} from "@/lib/db/schema";
import { encrypt, extractKeyPreview } from "@/lib/credentials/crypto";
import { withAdmin } from "@/lib/http/route-handlers";
import {
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
} from "@/lib/http/validation";

const ROUTE = "/api/admin/credentials";

// GET /api/admin/credentials

export const GET = withAdmin(ROUTE, async () => {
  const usageCount = db
    .select({
      credentialId: BuiltinAgentTable.credentialId,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(BuiltinAgentTable)
    .groupBy(BuiltinAgentTable.credentialId)
    .as("usage");

  const rows = await db
    .select({
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
      usageCount: sql<number>`coalesce(${usageCount.count}, 0)`.mapWith(Number),
    })
    .from(CredentialTable)
    .leftJoin(usageCount, eq(CredentialTable.id, usageCount.credentialId))
    .orderBy(CredentialTable.createdAt);

  return NextResponse.json(rows);
});

// POST /api/admin/credentials

// Derived from the single source of truth in schema.ts to prevent
// drift when new credential types are added (e.g. private_key).
const credentialTypeEnum = z.enum(CREDENTIAL_TYPES);
const credentialServiceTypeEnum = z.enum(CREDENTIAL_SERVICE_TYPES);

const createSchema = z.object({
  name: nonEmptyString,
  type: credentialTypeEnum,
  serviceType: credentialServiceTypeEnum,
  provider: optionalTrimmedString.optional(),
  restUrl: optionalTrimmedString.optional(),
  aguiUrl: optionalTrimmedString.optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const POST = withAdmin(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  const encryptedPayload = encrypt(body.payload);
  const keyPreview = extractKeyPreview(body.payload);

  const [row] = await db
    .insert(CredentialTable)
    .values({
      name: body.name,
      type: body.type,
      serviceType: body.serviceType,
      provider: body.provider ?? null,
      restUrl: body.restUrl ?? null,
      aguiUrl: body.aguiUrl ?? null,
      encryptedPayload,
      metadata: { keyPreview },
      enabled: true,
      createdBy: session.user.id,
    })
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

  return NextResponse.json(row, { status: 201 });
});
