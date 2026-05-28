import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { verifyConnection } from "@/lib/ssh/client";
import { loadSshAuth } from "@/lib/ssh/auth-loader";

const ROUTE = "/api/ssh-servers/verify-connection";

const Body = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  credentialId: z.string().uuid(),
});

/**
 * POST /api/ssh-servers/verify-connection
 */
export const POST = withEditor(ROUTE, async ({ req }) => {
  const body = await parseBody(req, Body);

  const auth = await loadSshAuth(body.credentialId);
  if (!auth) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `Credential ${body.credentialId} is missing, disabled, has the ` +
        "wrong type (must be basic_auth or private_key), or fails to decrypt.",
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
  return NextResponse.json(result);
});
