/**
 * Cache management — public re-exports.
 * @see docs/cache.md
 */

export {
  invalidateForCredentialChange,
  invalidateForMcpServerChange,
  invalidateForSkillChange,
  invalidateForDataSourceChange,
  invalidateForSshServerChange,
  invalidateForAgentChange,
} from "./invalidation";

export { getCacheHealth } from "./health";
export type { CacheHealthReport } from "./health";
