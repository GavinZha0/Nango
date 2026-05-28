/**
 * Skills subsystem entry. DB-first design — no filesystem layer.
 */

import "server-only";

export { skillPool, SkillPool } from "./skill-pool";
export type { SkillSpec, SkillSpecLoader } from "./skill-pool";
export { invalidateForSkillChange } from "./invalidation";
export { seedBuiltinSkills } from "./builtin-reconcile";
export { getDbSkillStorage } from "./storage";
