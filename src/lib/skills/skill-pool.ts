/**
 * Process-wide LRU of resolved {@link SkillSpec}s, keyed by skillId.
 *
 * See docs/skills.md.
 */

import "server-only";

import { LRUCache } from "lru-cache";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
import { parseSkillMd, type ParsedSkillMd } from "./parser";

/** Cached projection of one skill row + parsed SKILL.md.
 *  No filesystem locator — helper files live in `skill_file`. */
export interface SkillSpec {
  skillId: string;
  /** Frontmatter name; same as DB `name`.  Drives runtime indexing. */
  name: string;
  /** Cached frontmatter description (truncated for prompt injection). */
  description: string | null;
  /** Verbatim SKILL.md body (frontmatter + body — what `get_skill` returns). */
  skillMd: string;
  /** Parsed view of SKILL.md.  Frontmatter `extras` is preserved. */
  parsed: ParsedSkillMd;
  /** Where the skill comes from. */
  source: "builtin" | "local";
  /** True iff the skill row is enabled in DB. */
  enabled: boolean;
  /** "private" | "public" — visibility scope. */
  visibility: string;
  /** UUID of the user that originally created the row.
   *  Null when the creator was hard-purged (FK SET NULL); see docs/rbac.md. */
  createdBy: string | null;
}

export type SkillSpecLoader = (skillId: string) => Promise<SkillSpec | null>;

export interface SkillPoolOptions {
  max?: number;
  ttl?: number;
  load?: SkillSpecLoader;
}

import { getConfigMs, getConfigNumber } from "@/lib/config";

const DEFAULT_MAX: number = 500;
const DEFAULT_TTL_S: number = 600;

export class SkillPool {
  private readonly cache: LRUCache<string, SkillSpec>;
  private readonly load: SkillSpecLoader;

  constructor(opts: SkillPoolOptions = {}) {
    this.load = opts.load ?? defaultLoadSkillSpec;
    this.cache = new LRUCache<string, SkillSpec>({
      max: opts.max ?? getConfigNumber("cache.skill_pool.max", DEFAULT_MAX),
      ttl: opts.ttl ?? getConfigMs("cache.skill_pool.ttl", DEFAULT_TTL_S),
      fetchMethod: async (key: string): Promise<SkillSpec | undefined> => {
        const spec: SkillSpec | null = await this.load(key);
        return spec ?? undefined;
      },
    });
  }

  /**
   * CONTRACT: returns null when the skill is missing or disabled.
   * Concurrent in-flight loads for the same id share one fetch
   * (lru-cache built-in).
   */
  async get(skillId: string): Promise<SkillSpec | null> {
    const spec: SkillSpec | undefined = await this.cache.fetch(skillId);
    return spec ?? null;
  }

  /**
   * Fetch many specs, dropping nulls. Preserves input order minus drops.
   * Used to build the per-agent "Available Skills" prompt block.
   */
  async getMany(skillIds: readonly string[]): Promise<SkillSpec[]> {
    const out: SkillSpec[] = [];
    for (const id of skillIds) {
      const spec: SkillSpec | null = await this.get(id);
      if (spec) out.push(spec);
    }
    return out;
  }

  /** Drop a single cached entry.  Call after skill CRUD. */
  invalidate(skillId: string): void {
    this.cache.delete(skillId);
  }

  /** Clear every entry.  Reserved for migrations / panic. */
  invalidateAll(): void {
    this.cache.clear();
  }

  // Test helpers
  _size(): number {
    return this.cache.size;
  }

  _has(skillId: string): boolean {
    return this.cache.has(skillId);
  }
}

// QUIRK: `defaultLoadSkillSpec` MUST stay declared above the
// `skillPool` singleton — the constructor's default-arg lookup hits
// a TDZ in the bundled production build otherwise.

/** Reads the row + SKILL.md from DB. Pure DB read — no filesystem. */
export const defaultLoadSkillSpec: SkillSpecLoader = async (skillId) => {
  const rows = await db
    .select({
      id: SkillTable.id,
      name: SkillTable.name,
      description: SkillTable.description,
      skillMd: SkillTable.skillMd,
      source: SkillTable.source,
      enabled: SkillTable.enabled,
      visibility: SkillTable.visibility,
      createdBy: SkillTable.createdBy,
    })
    .from(SkillTable)
    .where(eq(SkillTable.id, skillId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (!row.enabled) return null;

  const source: "builtin" | "local" =
    row.source === "builtin" ? "builtin" : "local";

  // Re-parse the cached skillMd so callers can introspect frontmatter
  // (allowed-tools, context mode) without a second DB read.
  let parsed: ParsedSkillMd;
  try {
    parsed = parseSkillMd(row.skillMd);
  } catch {
    // CONTRACT: an unparseable row is invisible to the runtime; a
    // re-save (PATCH) repairs it.
    return null;
  }

  return {
    skillId: row.id,
    name: row.name,
    description: row.description,
    skillMd: row.skillMd,
    parsed,
    source,
    enabled: row.enabled,
    visibility: row.visibility,
    createdBy: row.createdBy,
  };
};

// HMR-survival via globalThis — without this, every `next dev` save
// would drop the cache and re-read the bytea blob on the next
// `get_skill` call. Correctness is unaffected (DB is source of truth);
// the pin just avoids a dev-only latency spike.
declare global {
  var __nangoSkillPool: SkillPool | undefined;
}

export const skillPool: SkillPool = (globalThis.__nangoSkillPool ??=
  new SkillPool());
