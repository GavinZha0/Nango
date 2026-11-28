import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import { detectLocalBrowsers } from "@/lib/playwright/browser-detect.server";

const ROUTE = "/api/mcp-servers/browser-env";

/**
 * GET /api/mcp-servers/browser-env
 *
 * One-shot local browser probe called when opening the MCP Market install
 * dialog for Playwright / Chrome DevTools so `--browser` defaults to an
 * installed browser (`chrome` or `msedge`).
 */
export const GET = withEditor(ROUTE, async () => {
  return NextResponse.json(detectLocalBrowsers());
});
