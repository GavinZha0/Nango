/**
 * GET /api/config/generative-ui — session-scoped read of enabled A2UI components.
 */

import "server-only";

import { NextResponse } from "next/server";

import { getConfig } from "@/lib/config";
import { withSession } from "@/lib/http/route-handlers";
import {
  DEFAULT_GENERATIVE_UI_COMPONENTS,
  GENERATIVE_UI_CONFIG_KEY,
  parseGenerativeUiComponents,
} from "@/lib/generative-ui/catalog";

const ROUTE = "/api/config/generative-ui";

export const GET = withSession(ROUTE, async () => {
  const raw = getConfig(
    GENERATIVE_UI_CONFIG_KEY,
    DEFAULT_GENERATIVE_UI_COMPONENTS.join(","),
  );
  const enabledComponents = parseGenerativeUiComponents(raw);
  return NextResponse.json({ enabledComponents });
});
