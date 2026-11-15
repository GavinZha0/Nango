import { NextResponse } from "next/server";

/**
 * Lightweight liveness probe for Desktop and container healthchecks.
 * Intentionally avoids DB queries and auth checks so readiness polling is fast.
 */
// CONTRACT: Liveness probe must remain unauthenticated (exempt from `withSession`)
// so Desktop readiness polling and container healthchecks succeed before login.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true });
}
