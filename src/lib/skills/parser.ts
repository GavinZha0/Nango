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
  /**
   * SQL scripts (normalized to `scripts/<path>.sql`) that may be executed
   * against a bound data source via `run_skill_sql_script`.
   * Accepted key spellings: `scripts-on-db` (canonical), `scripts_on_db`,
   * `scriptsOnDb`. Only `.sql` files under `scripts/` are accepted.
   */
  scriptsOnDb?: string[];
  /** Any other frontmatter key the author included, kept verbatim. Nested
   *  mappings are kept one level deep rather than flattened, so a sub-key can
   *  never shadow a first-class field. */
  extras: Record<string, string | string[] | Record<string, string | string[]>>;
}

/** A frontmatter value: a scalar, a sequence of scalars, or one-level mapping. */
type FrontmatterValue = string | string[] | Record<string, string | string[]>;

/** A scalar-or-list value, i.e. anything a first-class field may accept. */
type FrontmatterScalar = string | string[];

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

/** Spec bound: a skill description may be at most 1024 characters. */
const MAX_DESCRIPTION_LEN = 1_024;
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

  const body: string = lines.slice(closeIdx + 1).join("\n").replace(/^\n+/, "");

  const raw: Record<string, FrontmatterValue> = {};
  /** Absolute 1-based line of each key's declaration, used by error locators. */
  const declaredAt = new Map<string, number>();
  /** Keys whose value spans more than its own line. */
  const multilineKeys = new Set<string>();

  let i = 1;
  while (i < closeIdx) {
    const line: string = lines[i];
    const trimmed: string = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    // Keys are only recognised at the left margin. An indented line reaching
    // here is a block that no key above it claimed as its value.
    if (indentWidth(line) !== 0) {
      throw new SkillParseError(
        `SKILL.md line ${i + 1}: unexpected indentation inside frontmatter: ${trimmed}`,
      );
    }

    const colon: number = line.indexOf(":");
    if (colon === -1) {
      throw new SkillParseError(
        `SKILL.md line ${i + 1}: invalid frontmatter line (expected "key: value"): ${trimmed}`,
      );
    }
    const key: string = line.slice(0, colon).trim();
    if (key.length === 0) {
      throw new SkillParseError(
        `SKILL.md line ${i + 1}: frontmatter line has no key before the ':'`,
      );
    }

    const read = readFrontmatterValue(lines, i, closeIdx);
    raw[key] = read.value;
    declaredAt.set(key, i + 1);
    if (read.lastLine > i) multilineKeys.add(key);
    i = read.lastLine + 1;
  }

  /** `SKILL.md line N:` when the key is present, else a bare `SKILL.md:`. */
  const at = (key: string): string => {
    const line: number | undefined = declaredAt.get(key);
    return line === undefined ? "SKILL.md" : `SKILL.md line ${line}`;
  };

  /** Read a first-class field as a string, naming where it came from. */
  const scalarField = (key: string): string => {
    const value: FrontmatterValue | undefined = raw[key];
    if (value === undefined) {
      throw new SkillParseError(`${at(key)}: frontmatter \`${key}\` is required.`);
    }
    if (typeof value !== "string") {
      throw new SkillParseError(
        `${at(key)}: frontmatter \`${key}\` must be a string, not a list or nested block.`,
      );
    }
    return value;
  };

  // Required fields
  const name: string = scalarField("name");
  if (name.length === 0) {
    throw new SkillParseError(`${at("name")}: frontmatter \`name\` is required.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new SkillParseError(
      `${at("name")}: frontmatter \`name\` must be a kebab-case slug (a-z, 0-9, -, _; up to 64 chars). Got: ${name}`,
    );
  }
  delete raw.name;

  const description: string = scalarField("description");
  if (description.length === 0) {
    throw new SkillParseError(
      `${at("description")}: frontmatter \`description\` must not be empty.`,
    );
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    throw new SkillParseError(
      `${at("description")}: frontmatter \`description\` exceeds ${MAX_DESCRIPTION_LEN} characters (got ${description.length}).`,
    );
  }
  delete raw.description;

  // Version (first-class field; default "1.0.0"). The Agent Skills spec defines
  // no top-level `version` — compliant packs carry it under `metadata`, so fall
  // back to `metadata.version` when the author skipped our convention.
  let version = "1.0.0";
  if ("version" in raw) {
    const v: FrontmatterValue = raw.version as FrontmatterValue;
    if (typeof v === "string" && v.length > 0) version = v;
    delete raw.version;
  } else {
    const metadata: FrontmatterValue | undefined = raw.metadata;
    if (
      metadata !== undefined &&
      !Array.isArray(metadata) &&
      typeof metadata === "object"
    ) {
      const nested: string | string[] | undefined = metadata.version;
      if (typeof nested === "string" && nested.length > 0) version = nested;
    }
  }

  // Optional Skills 2.0 fields
  let context: string | undefined;
  if ("context" in raw) {
    const v: FrontmatterValue = raw.context as FrontmatterValue;
    if (typeof v === "string") context = v;
    delete raw.context;
  }

  let allowedTools: string[] | undefined;
  const allowedToolsKey =
    "allowed-tools" in raw
      ? "allowed-tools"
      : "allowedTools" in raw
        ? "allowedTools"
        : null;
  if (allowedToolsKey !== null) {
    const v: FrontmatterValue = raw[allowedToolsKey] as FrontmatterValue;
    if (Array.isArray(v)) allowedTools = v;
    else if (typeof v === "string") {
      // The spec spells this as one space-separated string (`read_file Bash`).
      allowedTools = v.split(/\s+/).filter((tool: string) => tool.length > 0);
    } else {
      throw new SkillParseError(
        `${at(allowedToolsKey)}: frontmatter \`${allowedToolsKey}\` must be a string or a list of strings.`,
      );
    }
    delete raw[allowedToolsKey];
  }

  // CONTRACT: the two declaration keys must stay single-line. Renaming or
  // deleting a declared file rewrites the SKILL.md text in place
  // (rewriteDeclaredScriptsInSkillMd), and that helper only understands the
  // inline forms — accepting a folded value there would leave the continuation
  // lines orphaned.
  const assertInlineDeclaration = (key: string): void => {
    if (!multilineKeys.has(key)) return;
    throw new SkillParseError(
      `${at(key)}: \`${key}\` must be one line — an inline array or a single path. ` +
        "Multi-line values are not supported for this key.",
    );
  };

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
    assertInlineDeclaration(sshRawKey);
    const v: FrontmatterScalar = raw[sshRawKey] as FrontmatterScalar;
    // Single bare value or empty string → coerce to array.
    const entries: string[] = v === "" ? [] : Array.isArray(v) ? v : [v];
    scriptsOnSsh = normalizeScriptsOnSsh(entries);
    delete raw[sshRawKey];
  }

  // SQL scripts that may run against a bound data source.
  let scriptsOnDb: string[] | undefined;
  const DB_KEY_CANONICAL = "scripts-on-db";
  const DB_KEY_SNAKE = "scripts_on_db";
  const DB_KEY_CAMEL = "scriptsOnDb";
  const dbRawKey = DB_KEY_CANONICAL in raw
    ? DB_KEY_CANONICAL
    : DB_KEY_SNAKE in raw
      ? DB_KEY_SNAKE
      : DB_KEY_CAMEL in raw
        ? DB_KEY_CAMEL
        : null;
  if (dbRawKey !== null) {
    assertInlineDeclaration(dbRawKey);
    const v: FrontmatterScalar = raw[dbRawKey] as FrontmatterScalar;
    const entries: string[] = v === "" ? [] : Array.isArray(v) ? v : [v];
    scriptsOnDb = normalizeScriptsOnDb(entries);
    delete raw[dbRawKey];
  }

  return {
    frontmatter: {
      name,
      description,
      version,
      ...(context !== undefined ? { context } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(scriptsOnSsh !== undefined ? { scriptsOnSsh } : {}),
      ...(scriptsOnDb !== undefined ? { scriptsOnDb } : {}),
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

interface FrontmatterValueRead {
  value: FrontmatterValue;
  /** Inclusive last line consumed. Equals the key's own line for inline values. */
  lastLine: number;
}

/** Indentation of a frontmatter line; tabs and spaces both count as one. */
function indentWidth(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0;
}

// `>` / `|` block scalar header with optional chomping and indent indicators
// (`>-`, `|+`, `>2`). Chomping is parsed and ignored: these values are consumed
// as metadata text, so trailing line breaks carry no meaning.
const BLOCK_SCALAR_HEADER = /^[|>][+-]?\d?$/;

// A line that opens `sub: value`, i.e. a nested mapping rather than prose.
// YAML resolves the same ambiguity by forbidding ": " inside a plain scalar.
const MAPPING_LINE = /^[^\s:][^:]*:(\s|$)/;

/** A block sequence item, including the bare `-` empty entry. */
const SEQUENCE_ITEM = /^-(\s.*|$)/;

/**
 * Read the value belonging to the key on `lines[idx]`, consuming any block of
 * more-indented lines that follows it.
 */
function readFrontmatterValue(
  lines: string[],
  idx: number,
  closeIdx: number,
): FrontmatterValueRead {
  const line: string = lines[idx];
  const colon: number = line.indexOf(":");
  const inline: string = line.slice(colon + 1).trim();
  if (inline.length > 0 && !BLOCK_SCALAR_HEADER.test(inline)) {
    return { value: parseValue(inline), lastLine: idx };
  }

  const block = collectIndentedBlock(lines, idx + 1, closeIdx, indentWidth(line));
  // A `key:` or block header with nothing indented under it is an empty value.
  if (block === null) return { value: "", lastLine: idx };
  const content: string[] = block.lines.filter((l) => l.trim() !== "");
  if (content.length === 0) return { value: "", lastLine: idx };

  if (content.every((l) => MAPPING_LINE.test(l.trim()))) {
    return { value: readNestedMapping(block.lines), lastLine: block.lastLine };
  }
  if (content.every((l) => SEQUENCE_ITEM.test(l.trim()))) {
    return { value: readSequence(block.lines), lastLine: block.lastLine };
  }
  return {
    value: foldLines(block.lines, inline.startsWith("|") ? "literal" : "folded"),
    lastLine: block.lastLine,
  };
}

/** Collect the contiguous, more-indented block that starts at `start`. */
function collectIndentedBlock(
  lines: string[],
  start: number,
  closeIdx: number,
  keyIndent: number,
): { lines: string[]; lastLine: number } | null {
  let lastContent = -1;
  let i = start;
  while (i < closeIdx) {
    const line: string = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (indentWidth(line) <= keyIndent) break;
    lastContent = i;
    i += 1;
  }
  if (lastContent === -1) return null;
  return { lines: lines.slice(start, lastContent + 1), lastLine: lastContent };
}

/**
 * Turn an indented block into text. `folded` joins consecutive content lines
 * with a single space and turns each blank line into a break, which is how YAML
 * folds a plain multi-line scalar; `literal` keeps the line breaks.
 */
function foldLines(entries: string[], mode: "folded" | "literal"): string {
  const content: string[] = entries.filter((l) => l.trim() !== "");
  if (content.length === 0) return "";
  const base: number = Math.min(...content.map(indentWidth));
  const dedented: string[] = entries.map((l) =>
    l.trim() === "" ? "" : l.slice(base).trimEnd(),
  );

  if (mode === "literal") return dedented.join("\n").replace(/\n+$/, "");

  let out = "";
  for (const entry of dedented) {
    if (entry === "") {
      if (out.length > 0) out += "\n";
      continue;
    }
    out += out.length === 0 || out.endsWith("\n") ? entry : ` ${entry}`;
  }
  return out;
}

/** Read `- item` lines as a list of scalars, ignoring blank separators. */
function readSequence(entries: string[]): string[] {
  const out: string[] = [];
  for (const line of entries) {
    const trimmed: string = line.trim();
    if (trimmed === "") continue;
    const parsed: string | string[] = parseValue(trimmed.replace(/^-\s*/, ""));
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  }
  return out;
}

/**
 * Read one level of nested mapping. Deeper lines fold into the sub-key's value;
 * two levels of mapping are not modelled, because no skill frontmatter field
 * consumes them.
 */
function readNestedMapping(entries: string[]): Record<string, string | string[]> {
  const content: string[] = entries.filter((l) => l.trim() !== "");
  const base: number = Math.min(...content.map(indentWidth));
  const out: Record<string, string | string[]> = {};

  let key: string | null = null;
  let inline = "";
  let tail: string[] = [];

  const flush = (): void => {
    const current: string | null = key;
    if (current === null) return;
    const tailContent: string[] = tail.filter((l) => l.trim() !== "");
    if (inline.length > 0) {
      out[current] =
        tailContent.length === 0
          ? parseValue(inline)
          : `${inline} ${foldLines(tail, "folded")}`;
    } else if (
      tailContent.length > 0 &&
      tailContent.every((l) => SEQUENCE_ITEM.test(l.trim()))
    ) {
      out[current] = readSequence(tail);
    } else {
      out[current] = foldLines(tail, "folded");
    }
    key = null;
    inline = "";
    tail = [];
  };

  for (const line of entries) {
    if (line.trim() === "") {
      if (key !== null) tail.push(line);
      continue;
    }
    if (indentWidth(line) === base) {
      flush();
      const colon: number = line.indexOf(":");
      key = line.slice(0, colon).trim();
      inline = line.slice(colon + 1).trim();
    } else {
      tail.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Validate and normalize declared script paths shared by scripts-on-ssh and
 * scripts-on-db.
 *
 * Entries may be bare (`probe.sh`, `lib/probe.sh`) or `scripts/`-prefixed;
 * everything normalizes to `scripts/<path>`. Sub-directories are allowed.
 * `allowedExtensions` is optional: SSH declarations intentionally accept any
 * extension, while DB declarations require `.sql`.
 */
function normalizeDeclaredScripts(
  entries: string[],
  key: string,
  allowedExtensions?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const extensionHint =
    allowedExtensions === undefined
      ? null
      : [...allowedExtensions].map((ext) => `.${ext}`).join(" / ");

  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;

    // Reject path traversal / absolute paths.
    if (entry.includes("\\") || entry.startsWith("/") || entry.includes("..")) {
      throw new SkillParseError(
        `${key} entry "${entry}" must be a relative path without \\\ or .. segments.`,
      );
    }

    // Normalize: strip optional leading `scripts/` prefix, then re-add.
    const bare = entry.startsWith("scripts/") ? entry.slice("scripts/".length) : entry;
    const segments = bare.split("/");
    for (const segment of segments) {
      if (segment.length === 0 || segment === ".") {
        throw new SkillParseError(
          `${key} entry "${entry}" must not contain empty or '.' segments.`,
        );
      }
      if (segment.startsWith(".")) {
        throw new SkillParseError(
          `${key} entry "${entry}" must not contain hidden segments (starting with '.').`,
        );
      }
    }

    if (allowedExtensions !== undefined) {
      const dot = bare.lastIndexOf(".");
      const ext = dot >= 0 ? bare.slice(dot + 1).toLowerCase() : "";
      if (!allowedExtensions.has(ext)) {
        throw new SkillParseError(
          `${key} entry "${entry}" must have a ${extensionHint} extension.`,
        );
      }
    }

    const normalized = `scripts/${bare}`;

    // Reject duplicates.
    if (seen.has(normalized)) {
      throw new SkillParseError(
        `${key} contains duplicate entry "${normalized}".`,
      );
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

/** SSH scripts may use any extension; runtime dispatch reports unsupported ones. */
function normalizeScriptsOnSsh(entries: string[]): string[] {
  return normalizeDeclaredScripts(entries, "scripts-on-ssh");
}

/** DB scripts must be `.sql`. */
function normalizeScriptsOnDb(entries: string[]): string[] {
  return normalizeDeclaredScripts(
    entries,
    "scripts-on-db",
    new Set(["sql"]),
  );
}

export interface RewriteDeclaredScriptsResult {
  skillMd: string;
  changed: boolean;
}

/** Frontmatter key spellings in the order parseSkillMd resolves them. */
const SSH_KEY_PRECEDENCE = [
  "scripts-on-ssh",
  "scripts_on_ssh",
  "scriptsOnSsh",
] as const;
const DB_KEY_PRECEDENCE = [
  "scripts-on-db",
  "scripts_on_db",
  "scriptsOnDb",
] as const;

/**
 * Rewrite declared-script entries in a SKILL.md frontmatter without touching
 * the rest of the document.
 *
 * Keys are normalized `scripts/<file>` paths; a value of `null` removes the
 * entry. The original key spelling, indentation, and inline scalar/array style
 * are preserved. Removing the last entry removes the whole key line.
 *
 * CONTRACT: the caller must parse `text` successfully first. This helper only
 * understands the inline forms, which stay true for the declaration keys
 * because parseSkillMd rejects a multi-line `scripts-on-ssh` / `scripts-on-db`
 * value outright.
 */
function rewriteDeclaredScriptsInSkillMd(
  text: string,
  keyPrecedence: readonly string[],
  updates: ReadonlyMap<string, string | null>,
): RewriteDeclaredScriptsResult {
  if (updates.size === 0) return { skillMd: text, changed: false };

  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return { skillMd: text, changed: false };

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return { skillMd: text, changed: false };

  let key: string | null = null;
  for (const candidate of keyPrecedence) {
    if (lines.slice(1, closeIdx).some((line) => frontmatterLineKey(line) === candidate)) {
      key = candidate;
      break;
    }
  }
  if (!key) return { skillMd: text, changed: false };

  // parseSkillMd lets later duplicate keys win, so update the last one.
  let targetIdx = -1;
  for (let i = 1; i < closeIdx; i += 1) {
    if (frontmatterLineKey(lines[i]) === key) targetIdx = i;
  }
  if (targetIdx === -1) return { skillMd: text, changed: false };

  const originalLine = lines[targetIdx];
  const carriageReturn = originalLine.endsWith("\r") ? "\r" : "";
  const line = carriageReturn
    ? originalLine.slice(0, -carriageReturn.length)
    : originalLine;
  const leading = line.match(/^[ \t]*/)?.[0] ?? "";
  const colon = line.indexOf(":");
  if (colon === -1) return { skillMd: text, changed: false };

  const rawValue = line.slice(colon + 1).trim();
  const parsedValue = parseValue(rawValue);
  const entries: string[] = Array.isArray(parsedValue)
    ? parsedValue
    : parsedValue.length === 0
      ? []
      : [parsedValue];

  const next: string[] = [];
  let changed = false;
  for (const entry of entries) {
    const normalized = entry.startsWith("scripts/")
      ? entry
      : `scripts/${entry}`;
    if (!updates.has(normalized)) {
      next.push(entry);
      continue;
    }
    changed = true;
    const replacement = updates.get(normalized);
    if (replacement !== null && replacement !== undefined) next.push(replacement);
  }
  if (!changed) return { skillMd: text, changed: false };

  if (next.length === 0) {
    lines.splice(targetIdx, 1);
  } else {
    const serialized = rawValue.startsWith("[")
      ? `[${next.map((entry) => JSON.stringify(entry)).join(", ")}]`
      : JSON.stringify(next[0]);
    lines[targetIdx] = `${leading}${key}: ${serialized}${carriageReturn}`;
  }

  return { skillMd: lines.join("\n"), changed: true };
}

export function rewriteScriptsOnSshInSkillMd(
  text: string,
  updates: ReadonlyMap<string, string | null>,
): RewriteDeclaredScriptsResult {
  return rewriteDeclaredScriptsInSkillMd(text, SSH_KEY_PRECEDENCE, updates);
}

export function rewriteScriptsOnDbInSkillMd(
  text: string,
  updates: ReadonlyMap<string, string | null>,
): RewriteDeclaredScriptsResult {
  return rewriteDeclaredScriptsInSkillMd(text, DB_KEY_PRECEDENCE, updates);
}

function frontmatterLineKey(line: string): string | null {
  const content = line.endsWith("\r") ? line.slice(0, -1) : line;
  // Left-margin keys only: a declaration nested inside another mapping is not
  // a declaration, and rewriting it would corrupt the parent block.
  if (content.length > 0 && /^[ \t]/.test(content)) return null;
  const colon = content.indexOf(":");
  if (colon === -1) return null;
  return content.slice(0, colon).trim();
}

/**
 * Diff a parsed `scripts-on-ssh` declaration against the set of script paths
 * that actually exist (or are about to be written).
 *
 * Pure by design: callers supply the path set from wherever it is known —
 * the in-memory import entries or `SkillStorage.listFiles()` — instead of this
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

export const findMissingDeclaredScripts = findMissingSshScripts;

/**
 * Editor-facing explanation for a dangling declared-script entry.
 *
 * Lists the usable `scripts/` files because the usual cause is a filename
 * typo, and the author is the only one who can pick the right one.
 */
export function describeMissingDeclaredScripts(
  missing: readonly string[],
  availablePaths: Iterable<string>,
  key = "scripts-on-ssh",
): string {
  const availableScripts = [...availablePaths].filter((p) =>
    p.startsWith("scripts/"),
  );
  const found =
    availableScripts.length > 0
      ? `Present under scripts/: ${availableScripts.join(", ")}.`
      : "This skill has no files under scripts/.";
  return (
    `${key} declares missing file(s): ${missing.join(", ")}. ` +
    `Drop them from the declaration, or supply them under scripts/. ${found}`
  );
}

export function describeMissingSshScripts(
  missing: readonly string[],
  availablePaths: Iterable<string>,
): string {
  return describeMissingDeclaredScripts(
    missing,
    availablePaths,
    "scripts-on-ssh",
  );
}
