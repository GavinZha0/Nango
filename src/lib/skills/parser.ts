/**
 * Minimal YAML frontmatter parser for SKILL.md (Claude Skills).
 *
 * See docs/skills.md.
 */

/** Required + optional frontmatter fields. */
export interface SkillFrontmatter {
  /** Stable machine-readable name; must match the skill directory name. */
  name: string;
  /** What the skill does + when to use it.  Drives trigger matching. */
  description: string;
  /** Free-form version string. Defaults to `"1.0.0"` when absent.
   *  Informational; not consumed at runtime. */
  version: string;
  /** Skills 2.0: inline | fork | background. Parsed but unused at runtime. */
  context?: string;
  /** Skills 2.0: tool whitelist. Parsed but unused at runtime. */
  allowedTools?: string[];
  /**
   * PyPI packages required by `scripts/*.py` in this skill.
   * `scripts/collect-skill-deps.ts` aggregates these into
   * `docker/sandbox/requirements.txt` at sandbox image build time.
   * Entries are full pip specs with optional version specifier
   * (e.g. `["scikit-learn>=1.3", "scipy"]`). The sandbox image
   * always ships `duckdb / pandas / numpy / pyarrow` regardless.
   *
   * NOTE: enforced only at image build time. Custom (local) skills
   * inherit whatever the running image has — their declarations are
   * advisory until promoted to builtin.
   */
  dependenciesPython?: string[];
  /** Any other frontmatter key the author included, kept verbatim. */
  extras: Record<string, string | string[]>;
}

export interface ParsedSkillMd {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** Thrown when SKILL.md cannot be parsed.  Message is end-user friendly. */
export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
  }
}

const MAX_DESCRIPTION_LEN = 1_000;
const MIN_DESCRIPTION_LEN = 10;
/** Skill names are slug-like; matches Claude's published examples. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * CONTRACT: throws {@link SkillParseError} on any structural or
 * required-field problem; never returns a partially-valid object.
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  const normalized: string = text.replace(/\r\n/g, "\n");

  // Frontmatter must start at byte 0 so file shape stays predictable.
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    throw new SkillParseError(
      "SKILL.md must begin with a `---` frontmatter delimiter on the first line.",
    );
  }

  // QUIRK: line-based scan for the closing `---` so values that contain
  // "---" inside a quoted string don't get miscounted.
  const lines: string[] = normalized.split("\n");
  let closeIdx: number = -1;
  for (let i: number = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new SkillParseError(
      "SKILL.md is missing the closing `---` frontmatter delimiter.",
    );
  }

  const fmLines: string[] = lines.slice(1, closeIdx);
  const body: string = lines.slice(closeIdx + 1).join("\n").replace(/^\n+/, "");

  const raw: Record<string, string | string[]> = {};
  for (const line of fmLines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const colon: number = line.indexOf(":");
    if (colon === -1) {
      throw new SkillParseError(
        `Invalid frontmatter line (expected "key: value"): ${line}`,
      );
    }
    const key: string = line.slice(0, colon).trim();
    const rawValue: string = line.slice(colon + 1).trim();
    raw[key] = parseValue(rawValue);
  }

  // Required fields
  const name: unknown = raw.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new SkillParseError("Frontmatter `name` is required.");
  }
  if (!NAME_PATTERN.test(name)) {
    throw new SkillParseError(
      `Frontmatter \`name\` must be a kebab-case slug (a-z, 0-9, -, _; up to 64 chars). Got: ${name}`,
    );
  }
  delete raw.name;

  const description: unknown = raw.description;
  if (typeof description !== "string" || description.length === 0) {
    throw new SkillParseError("Frontmatter `description` is required.");
  }
  if (description.length < MIN_DESCRIPTION_LEN) {
    throw new SkillParseError(
      `Frontmatter \`description\` is too short (need at least ${MIN_DESCRIPTION_LEN} chars).`,
    );
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    throw new SkillParseError(
      `Frontmatter \`description\` exceeds ${MAX_DESCRIPTION_LEN} characters.`,
    );
  }
  delete raw.description;

  // Version (first-class field; default "1.0.0")
  let version = "1.0.0";
  if ("version" in raw) {
    const v: string | string[] | undefined = raw.version;
    if (typeof v === "string" && v.length > 0) version = v;
    delete raw.version;
  }

  // Optional Skills 2.0 fields
  let context: string | undefined;
  if ("context" in raw) {
    const v: string | string[] | undefined = raw.context;
    if (typeof v === "string") context = v;
    delete raw.context;
  }

  let allowedTools: string[] | undefined;
  if ("allowed-tools" in raw) {
    const v: string | string[] = raw["allowed-tools"];
    allowedTools = Array.isArray(v) ? v : [v];
    delete raw["allowed-tools"];
  } else if ("allowedTools" in raw) {
    const v: string | string[] = raw.allowedTools;
    allowedTools = Array.isArray(v) ? v : [v];
    delete raw.allowedTools;
  }

  // PyPI deps for sandbox image build aggregation.
  // Inline-array syntax only (matches `parseValue`'s capability).
  let dependenciesPython: string[] | undefined;
  if ("dependencies-python" in raw) {
    const v: string | string[] = raw["dependencies-python"];
    if (typeof v === "string") {
      // Single bare value or empty string. Empty == no deps.
      dependenciesPython = v.length === 0 ? [] : [v];
    } else {
      dependenciesPython = v;
    }
    delete raw["dependencies-python"];
  }

  return {
    frontmatter: {
      name,
      description,
      version,
      ...(context !== undefined ? { context } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(dependenciesPython !== undefined ? { dependenciesPython } : {}),
      extras: raw,
    },
    body,
  };
}

// Order: quoted strings → inline arrays → bare strings.
function parseValue(raw: string): string | string[] {
  if (raw.length === 0) return "";

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }

  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner: string = raw.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner
      .split(",")
      .map((p) => p.trim())
      .map((p) => {
        if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1);
        if (p.startsWith("'") && p.endsWith("'")) return p.slice(1, -1);
        return p;
      });
  }

  return raw;
}
