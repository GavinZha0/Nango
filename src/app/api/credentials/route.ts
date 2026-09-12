import "server-only";

import { NextResponse } from "next/server";
import { withEditor } from "@/lib/http/route-handlers";
import { listIntegrationCredentialsForSelector } from "@/lib/credentials/lookup";

const ROUTE = "/api/credentials";

export const GET = withEditor(ROUTE, async ({ req }) => {
  const url = new URL(req.url);
  const purpose = url.searchParams.get("purpose");

  if (purpose === "suite-variable") {
    const items = await listIntegrationCredentialsForSelector();
    return NextResponse.json(items);
  }

  return NextResponse.json([]);
});
