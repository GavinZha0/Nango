/**
 * Shared cache-root resolution. See docs/data-sources.md.
 */

import * as path from "node:path";

import { getConfig } from "@/lib/config";

/**
 * Resolve the cache root. The `datasource.cache_root` config override
 * wins when non-empty; next is `NANGO_DEFAULT_CACHE_ROOT` (injected by
 * the desktop runtime); otherwise the default is `<cwd>/.cache/datasource/`.
 */
export function resolveCacheRoot(): string {
  const fromConfig = getConfig("datasource.cache_root", "");
  if (fromConfig.length > 0) return path.resolve(fromConfig);
  const fromEnv = process.env.NANGO_DEFAULT_CACHE_ROOT?.trim();
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(process.cwd(), ".cache", "datasource");
}
