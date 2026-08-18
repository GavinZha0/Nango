import "server-only";

import { NextResponse } from "next/server";

import { updateWorkflowNode } from "@/lib/artifacts/update-artifact";
import { withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { CanonicalNodeSchema } from "@/lib/workflows/spec/schema";

const ROUTE = "/api/artifacts/[id]/nodes/[nodeId]";

/**
 * PATCH /api/artifacts/[id]/nodes/[nodeId]
 * 
 * Precise update API for a single workflow node. Solves the Lost Update
 * problem by only sending the modified node from the client, and allowing
 * the server to read the latest workflow spec inside a transaction before
 * applying the patch.
 */
export const PATCH = withSession<{ id: string; nodeId: string }>(
  ROUTE,
  async ({ req, params, session, log }) => {
    // 1. Validate the incoming body is a valid CanonicalNode
    const nodePatch = await parseBody(req, CanonicalNodeSchema);

    // 2. Parse the target nodeId
    const nodeIdNum = parseInt(params.nodeId, 10);
    if (isNaN(nodeIdNum)) {
      return NextResponse.json(
        { message: "Invalid nodeId parameter" },
        { status: 400 }
      );
    }

    // 3. Delegate to the service layer for atomic update
    const bundle = await updateWorkflowNode(
      params.id,
      nodeIdNum,
      nodePatch,
      session.user.id
    );

    log.info(
      {
        event: "workflow_node_update",
        artifactId: bundle.node.id,
        nodeId: nodeIdNum,
      },
      "workflow node updated",
    );

    // 4. Return the standard ArtifactBundle shape matching GET / PATCH artifact
    return NextResponse.json(bundle);
  },
);
