import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { getCredentialFieldsById } from "@/lib/credentials/lookup";
import { getDataSource } from "@/lib/data-sources/registry.server";
import { DatabaseConnectionBase } from "@/lib/data-sources/secrets-base";
import {
  dataSourceParams,
  dataSourceProvider,
} from "@/lib/data-sources/validation";
import { isSupportedDataSource, type DataSourceId } from "@/lib/data-sources/types";

const ROUTE = "/api/data-sources/test-connection";

/**
 * POST /api/data-sources/test-connection
 */
const bodySchema = z.object({
  provider: dataSourceProvider,
  credentialId: z.string().uuid("credentialId must be a UUID"),
  host: z.string().trim().min(1, "host is required"),
  port: z.number().int().positive().max(65535),
  database: z.string().trim().min(1, "database is required"),
  params: dataSourceParams.optional(),
});

export const POST = withEditor(ROUTE, async ({ req }) => {
  const body = await parseBody(req, bodySchema);

  if (!isSupportedDataSource(body.provider)) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `Provider "${body.provider}" is not registered.`,
    );
  }

  const cred = await getCredentialFieldsById(body.credentialId);
  if (!cred) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `Credential ${body.credentialId} not found or disabled.`,
    );
  }
  const parsed = DatabaseConnectionBase.safeParse(cred.fields);
  if (!parsed.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "Credential payload is malformed (missing user / password).",
    );
  }

  const source = getDataSource(body.provider as DataSourceId);
  // Synthetic ResolvedDataSource — id/name aren't used by adapters'
  // testConnection (they only touch host / port / database / params /
  // username / password). Sentinel id "__test__" lets accidental
  // misuse show up in logs.
  const result = await source.testConnection(
    {
      id: "__test__",
      name: "__test__",
      provider: body.provider as DataSourceId,
      host: body.host,
      port: body.port,
      database: body.database,
      params: body.params ?? {},
      username: parsed.data.username,
      password: parsed.data.password,
      policy: { readOnly: true, tableAllowlist: null, tableDenylist: [] },
    },
    req.signal,
  );
  return NextResponse.json(result);
});
