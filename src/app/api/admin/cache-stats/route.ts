import "server-only";

import { withAdmin } from "@/lib/http/route-handlers";
import { getCacheHealth } from "@/lib/cache/health";

const ROUTE = "/api/admin/cache-stats";

export const GET = withAdmin(ROUTE, async () => {
  return Response.json(getCacheHealth());
});
