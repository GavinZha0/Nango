/**
 * Re-export shim — canonical definitions moved to `@/lib/cache/invalidation`.
 * @see docs/cache.md §3
 */
export {
  invalidateForCredentialChange,
  invalidateForMcpServerChange,
  invalidateForDataSourceChange,
  invalidateForSshServerChange,
} from "@/lib/cache/invalidation";
