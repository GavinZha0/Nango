/**
 * Shared cache-root resolution. See docs/data-sources.md.
 */

import * as path from "node:path";

import { getConfig } from "@/lib/config";

/**
 * Resolve the cache root. The `datasource.cache_root` config override
 * wins when non-empty; otherwise the default is `<cwd>/.cache/datasource/`.
 */
export function resolveCacheRoot(): string {
  const fromConfig = getConfig("datasource.cache_root", "");
  if (fromConfig.length > 0) return path.resolve(fromConfig);
  return path.join(process.cwd(), ".cache", "datasource");
}
