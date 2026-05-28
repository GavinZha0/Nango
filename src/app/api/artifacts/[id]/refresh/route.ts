import "server-only";

import { NextResponse } from "next/server";

import { refreshArtifact } from "@/lib/artifacts/refresh-artifact";
import { withSession } from "@/lib/http/route-handlers";

/**
 * POST /api/artifacts/[id]/refresh — re-run the artifact's
 * backing workflow, bypassing the L2 workflow-output cache.
 *
 * No request body — refresh is "re-do whatever I'd do on GET, but
 * fresh". Response shape matches GET (the W1.6 render-ready
 * bundle): `{ node, workflow?, data?, fromCache?, executedAt? }`.
 *
 * Per D31: this endpoint is user-facing ("Refresh" button on the
 * artifact page). The workflow concept itself is implementation
 * detail; the user sees "I want fresh data for this chart".
 *
 * W1.6.4 status: the underlying executor is still stubbed; the
 * bundle returns without a `data` field. W1.7 integration will
 * wire the real engine + L2 cache + tool registry; the endpoint
 * contract stays unchanged.
 */
const ROUTE = "/api/artifacts/[id]/refresh";

export const POST = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session, log }) => {
    const bundle = await refreshArtifact(params.id, session.user.id);
    log.info(
      {
        event: "artifact_refresh",
        artifactId: bundle.node.id,
        hasWorkflow: bundle.workflow !== undefined,
        dataResolved: bundle.data !== undefined,
      },
      "artifact refreshed",
    );
    return NextResponse.json(bundle);
  },
);
