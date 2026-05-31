/**
 * Re-export shim — canonical definitions moved to `@/lib/cache/invalidation`.
 *
 * See docs/cache.md.
 */
export {
  invalidateForCredentialChange,
  invalidateForMcpServerChange,
  invalidateForDataSourceChange,
  invalidateForSshServerChange,
} from "@/lib/cache/invalidation";
