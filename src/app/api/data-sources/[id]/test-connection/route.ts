import "server-only";

import { NextResponse } from "next/server";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { resolveDataSourceByIdIncludingDisabled } from "@/lib/data-sources/lookup";
import { getDataSource } from "@/lib/data-sources/registry.server";

const ROUTE = "/api/data-sources/[id]/test-connection";

/**
 * POST /api/data-sources/[id]/test-connection
 */
export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, req }) => {
    const { id } = params;

    const lookup = await resolveDataSourceByIdIncludingDisabled(id);
    if (!lookup.ok) {
      // 404 for missing row, 400 for everything else (credential
      // misconfig, unsupported provider, decrypt failure) — caller
      // gets a precise reason to act on without us leaking internals.
      const status = lookup.error === "NOT_FOUND" ? 404 : 400;
      throw new ApiError(
        lookup.error === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_FAILED",
        status,
        lookup.message,
      );
    }

    const source = getDataSource(lookup.resolved.provider);
    const result = await source.testConnection(lookup.resolved, req.signal);
    return NextResponse.json(result);
  },
);
