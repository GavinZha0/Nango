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
   * Scripts (normalized to `scripts/<file>`) that must run on a bound SSH
   * host via `run_skill_script_on_ssh` instead of the sandbox.
   * Accepted key spellings: `scripts-on-ssh` (canonical), `scripts_on_ssh`,
   * `scriptsOnSsh`. Absent key = every script runs in the sandbox (default,
   * unchanged behavior).
   *
   * See docs/skills.md and the run_skill_script_on_ssh design doc.
   */
  scriptsOnSsh?: string[];
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

  // Scripts that must run on an SSH host rather than in the sandbox.
  // Three canonical alias spellings — same precedence pattern as allowedTools.
  let scriptsOnSsh: string[] | undefined;
  const SSH_KEY_CANONICAL = "scripts-on-ssh";
  const SSH_KEY_SNAKE = "scripts_on_ssh";
  const SSH_KEY_CAMEL = "scriptsOnSsh";
  const sshRawKey = SSH_KEY_CANONICAL in raw
    ? SSH_KEY_CANONICAL
    : SSH_KEY_SNAKE in raw
      ? SSH_KEY_SNAKE
      : SSH_KEY_CAMEL in raw
        ? SSH_KEY_CAMEL
        : null;
  if (sshRawKey !== null) {
    const v: string | string[] = raw[sshRawKey];
    // Single bare value or empty string → coerce to array.
    const entries: string[] = v === "" ? [] : Array.isArray(v) ? v : [v];
    scriptsOnSsh = normalizeScriptsOnSsh(entries);
    delete raw[sshRawKey];
  }

  return {
    frontmatter: {
      name,
      description,
      version,
      ...(context !== undefined ? { context } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(scriptsOnSsh !== undefined ? { scriptsOnSsh } : {}),
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

/**
 * Interpreter extensions accepted in scripts-on-ssh (must stay in sync with
 * INTERPRETER_BY_EXTENSION in skills/runtime-tools.ts).
 */
const ALLOWED_SSH_SCRIPT_EXTENSIONS = new Set(["py", "sh"]);

/**
 * Validate and normalize a list of raw `scripts-on-ssh` entries.
 *
 * Each entry is accepted as either a bare filename (`probe.sh`) or a
 * `scripts/`-prefixed path (`scripts/probe.sh`).  Both normalize to
 * `scripts/<file>`.  Only one level under `scripts/` is allowed (the
 * design deliberately forbids sub-directories to keep the lookup trivial).
 *
 * Throws {@link SkillParseError} on:
 *   - unsupported file extension (only .py / .sh)
 *   - path traversal (`..`, leading `/`, backslash)
 *   - hidden segments (segment starting with `.`)
 *   - sub-directory below `scripts/` (e.g. `scripts/sub/file.sh`)
 *   - duplicate entries
 */
function normalizeScriptsOnSsh(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;

    // Reject path traversal / absolute paths.
    if (entry.includes("\\") || entry.startsWith("/") || entry.includes("..")) {
      throw new SkillParseError(
        `scripts-on-ssh entry "${entry}" must be a relative path without \\\ or .. segments.`,
      );
    }

    // Normalize: strip optional leading `scripts/` prefix, then re-add.
    const bare = entry.startsWith("scripts/") ? entry.slice("scripts/".length) : entry;

    // Reject sub-directories (only `scripts/<file>` is allowed, not `scripts/sub/file`).
    if (bare.includes("/")) {
      throw new SkillParseError(
        `scripts-on-ssh entry "${entry}" must be a direct child of scripts/ (no sub-directories).`,
      );
    }

    // Reject hidden files (segment starts with `.`).
    if (bare.startsWith(".")) {
      throw new SkillParseError(
        `scripts-on-ssh entry "${entry}" must not be a hidden file (starts with '.').`,
      );
    }

    // Check extension.
    const dotIdx = bare.lastIndexOf(".");
    const ext = dotIdx >= 0 ? bare.slice(dotIdx + 1).toLowerCase() : "";
    if (!ALLOWED_SSH_SCRIPT_EXTENSIONS.has(ext)) {
      throw new SkillParseError(
        `scripts-on-ssh entry "${entry}" has unsupported extension ".${ext}". ` +
          `Allowed: ${[...ALLOWED_SSH_SCRIPT_EXTENSIONS].map((e) => "." + e).join(", ")}.`,
      );
    }

    const normalized = `scripts/${bare}`;

    // Reject duplicates.
    if (seen.has(normalized)) {
      throw new SkillParseError(
        `scripts-on-ssh contains duplicate entry "${normalized}".`,
      );
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

/**
 * Diff a parsed `scripts-on-ssh` declaration against the set of script paths
 * that actually exist (or are about to be written).
 *
 * Pure by design: callers supply the path set from wherever it is known —
 * the in-memory ZIP entries or `SkillStorage.listFiles()` — instead of this
 * module poking storage. That keeps the check usable before a skill row has
 * any files at all.
 *
 * @param entries        `frontmatter.scriptsOnSsh` (already normalized to
 *                       `scripts/<file>` by {@link parseSkillMd}).
 * @param availablePaths Paths to compare against, in the same normalized form.
 * @returns The declared entries with no backing file, in declaration order.
 */
export function findMissingSshScripts(
  entries: readonly string[],
  availablePaths: Iterable<string>,
): string[] {
  const available = new Set(availablePaths);
  return entries.filter((entry) => !available.has(entry));
}

/**
 * Editor-facing explanation for a dangling `scripts-on-ssh` entry.
 *
 * Lists the usable `scripts/` files because the usual cause is a filename
 * typo, and the author is the only one who can pick the right one.
 */
export function describeMissingSshScripts(
  missing: readonly string[],
  availablePaths: Iterable<string>,
): string {
  const availableScripts = [...availablePaths].filter((p) =>
    p.startsWith("scripts/"),
  );
  const found =
    availableScripts.length > 0
      ? `Present under scripts/: ${availableScripts.join(", ")}.`
      : "This skill has no files under scripts/.";
  return (
    `scripts-on-ssh declares missing file(s): ${missing.join(", ")}. ` +
    `Drop them from the declaration, or supply them under scripts/. ${found}`
  );
}
