import "server-only";

import { NextResponse } from "next/server";

import { saveSnapshot } from "@/lib/artifacts/save-snapshot";
import { withSession } from "@/lib/http/route-handlers";

const ROUTE = "/api/artifacts/[id]/snapshot";

/**
 * POST /api/artifacts/[id]/snapshot
 *
 * Executes the artifact's workflow live and persists the result as
 * the current snapshot. Only the artifact owner may call this.
 *
 * Returns the same bundle shape as GET with `fromSnapshot=false` and
 * the fresh data. The caller may then display the result and choose
 * to switch `view_mode` to 'snapshot' via PATCH.
 */
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
      // Body may be empty on plain POST snapshot requests
    }

    const bundle = await saveSnapshot(params.id, session.user.id, inputValues);
    log.info(
      { event: "artifact_snapshot_saved", artifactId: params.id, hasInputValues: inputValues !== undefined },
      "artifact snapshot saved",
    );
    return NextResponse.json(bundle);
  },
);
