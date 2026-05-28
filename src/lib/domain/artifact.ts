export const ARTIFACT_TYPES = [
  "code",
  "chart",
  "dashboard",
  "image",
  "html",
  "ppt",
  "report",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/**
 * Discriminator on `artifact.kind`.
 *  - `folder`: organisational node. Categories at `parent_id IS NULL`
 *    AND user-created sub-folders. Never has `type`/`content`.
 *  - `artifact`: leaf, carries `type` + `content`.
 *
 * @see docs/artifact-dashboard-migration.md §2 decisions 1-2
 */
export const ARTIFACT_KIND = ["folder", "artifact"] as const;

export type ArtifactKind = (typeof ARTIFACT_KIND)[number];

/**
 * System-managed top-level category folders seeded into every user's
 * artifact tree on registration. Each category has a fixed display
 * name + the list of `ArtifactType` values that conceptually belong
 * under it.
 *
 * Invariants:
 *  - Names are stable identifiers used by both the seed (insert by
 *    name) and the type→category resolver (lookup by type value).
 *  - Each `ArtifactType` MUST appear in exactly one category's `types`
 *    list — `lookupCategoryForType` would otherwise be ambiguous.
 *  - User-created folders MUST have a `parent_id`; the seed rows are
 *    the only rows in the system with `parent_id IS NULL`.
 *  - Seed rows are immutable to the user: rename / delete / reparent
 *    are all rejected at the API layer.
 *
 * Adding a new type later: (1) extend `ARTIFACT_TYPES`, (2) extend
 * `SEED_CATEGORIES` to place it under a category (or add a new
 * category), (3) write a migration that back-fills the new seed row
 * for every existing user.
 *
 * @see docs/artifact-dashboard-migration.md §4.1.2
 */
export const SEED_CATEGORIES: readonly {
  readonly name: string;
  readonly types: readonly ArtifactType[];
}[] = [
  { name: "Charts", types: ["chart"] },
  { name: "Reports", types: ["report"] },
  { name: "Code", types: ["code"] },
  { name: "Images", types: ["image"] },
  { name: "HTML", types: ["html"] },
  { name: "PPT", types: ["ppt"] },
  // Note: the legacy `dashboard` artifact type is intentionally NOT
  // seeded a category here. Dashboards proper live in their own
  // `dashboard` table (M3 milestone); the `dashboard` value on
  // `artifact.type` is kept in `ARTIFACT_TYPES` only as a defensive
  // forward-compat slot, but no producer currently emits it.
] as const;

/**
 * Resolve which seed-category a given artifact type belongs to.
 * Returns `undefined` for `type` values not mapped (e.g. legacy
 * `"dashboard"`) — callers should reject rather than silently land
 * the row at a NULL parent.
 */
export function lookupCategoryForType(
  type: ArtifactType,
): (typeof SEED_CATEGORIES)[number] | undefined {
  return SEED_CATEGORIES.find((c) => c.types.includes(type));
}
