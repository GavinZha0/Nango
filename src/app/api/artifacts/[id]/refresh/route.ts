import "server-only";

import { NextResponse } from "next/server";

import { refreshArtifact } from "@/lib/artifacts/refresh-artifact";
import { withSession } from "@/lib/http/route-handlers";

/**
 * POST /api/artifacts/[id]/refresh — force-fresh re-execute of the
 * artifact's backing workflow.
 *
 * No request body — refresh is "re-do whatever I'd do on GET, but
 * fresh". Response shape matches GET:
 * `{ node, workflow?, data?, fromCache?, executedAt? }`.
 *
 * User-facing semantics: this is the "Refresh" button on the artifact
 * page. The workflow concept stays implementation-internal — the user
 * sees "give me fresh data for this chart".
 *
 * See docs/workflow.md.
 */
const ROUTE = "/api/artifacts/[id]/refresh";

export const POST = withSession<{ id: string }>(
  ROUTE,
  async ({ req, params, session, log }) => {
    let inputValues: Record<string, unknown> | undefined;
    try {
      const body = await req.json();
      if (body && typeof body === "object" && body.inputs && typeof body.inputs === "object") {
        inputValues = body.inputs as Record<string, unknown>;
      }
    } catch {
      // Body may be empty on plain POST refresh requests
    }

    const bundle = await refreshArtifact(params.id, session.user.id, inputValues);
    log.info(
      {
        event: "artifact_refresh",
        artifactId: bundle.node.id,
        hasWorkflow: bundle.workflow !== undefined,
        dataResolved: bundle.data !== undefined,
        hasInputValues: inputValues !== undefined,
      },
      "artifact refreshed",
    );
    return NextResponse.json(bundle);
  },
);
