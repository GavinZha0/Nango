import "server-only";

import { NextResponse } from "next/server";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { verifyConnection } from "@/lib/ssh/client";
import { resolveSshServerById } from "@/lib/ssh/lookup";

const ROUTE = "/api/ssh-servers/[id]/verify-connection";

/**
 * POST /api/ssh-servers/[id]/verify-connection
 */
export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ params }) => {
    const { id } = params;
    const lookup = await resolveSshServerById(id);
    if (!lookup.ok) {
      const status = lookup.error === "NOT_FOUND" ? 404 : 400;
      throw new ApiError(
        lookup.error === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_FAILED",
        status,
        lookup.message,
      );
    }

    const server = lookup.resolved;
    // Capture-mode for the editor's Verify button: do NOT pre-pin
    // the saved fingerprint. We want a single click to (a) capture
    // whatever the host sends right now AND (b) attempt auth. The
    // editor compares the returned fingerprint against the row's
    // current pin to render the "host key changed" red hint.
    // SECURITY: the actual `run_ssh_command` runtime path always
    // strict-pins; this relaxation is editor-only.
    const result = await verifyConnection(
      {
        host: server.host,
        port: server.port,
        knownHostFingerprint: null,
      },
      server.auth,
    );
    return NextResponse.json({
      ...result,
      /** Pinned fingerprint at save time — the editor diffs against
       *  `result.fingerprint` to decide whether to show the
       *  "host key changed" hint. */
      pinnedFingerprint: server.knownHostFingerprint,
    });
  },
);
