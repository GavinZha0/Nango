/**
 * GET /api/calendar-credentials — list enabled calendar credentials
 * for the agent editor's Calendars binding section. Mirrors the
 * pattern in `/api/datasource-credentials`.
 */

import "server-only";

import { NextResponse } from "next/server";

import { listCalendarSources } from "@/lib/calendar/lookup";
import { withSession } from "@/lib/http/route-handlers";

export const dynamic = "force-dynamic";

export const GET = withSession("/api/calendar-credentials", async () => {
  const rows = await listCalendarSources();
  return NextResponse.json(rows);
});
