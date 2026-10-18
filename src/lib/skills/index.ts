/**
 * Skills subsystem entry. DB-first — no filesystem layer at runtime.
 *
 * See docs/skills.md.
 */

import "server-only";

export { skillPool, SkillPool } from "./skill-pool";
export type { SkillSpec, SkillSpecLoader } from "./skill-pool";
export { invalidateForSkillChange } from "./invalidation";
export { getDbSkillStorage } from "./storage";
