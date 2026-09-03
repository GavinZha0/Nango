/**
 * CopilotKit Built-in Agent runtime endpoint.
 */

import { NextRequest } from "next/server";
import type { Logger } from "pino";

import { runner } from "@/lib/runner";
import { withSession } from "@/lib/http/route-handlers";
import { isAdmin, isEditor } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

const ROUTE = "/api/copilotkit/builtin/[...path]";
type RouteParams = { path: string[] };

async function handler(
  req: NextRequest,
  args: {
    userId: string;
    isAdmin?: boolean;
    isEditor?: boolean;
    requestId: string;
    log: Logger;
  },
): Promise<Response> {
  return runner.runBuiltinChatRequest(req, args);
}

export const GET = withSession<RouteParams>(ROUTE, async ({ req, session, requestId, log }) => {
  return handler(req, {
    userId: session.user.id,
    isAdmin: isAdmin(session),
    isEditor: isEditor(session),
    requestId,
    log,
  });
});

export const POST = withSession<RouteParams>(ROUTE, async ({ req, session, requestId, log }) => {
  return handler(req, {
    userId: session.user.id,
    isAdmin: isAdmin(session),
    isEditor: isEditor(session),
    requestId,
    log,
  });
});
