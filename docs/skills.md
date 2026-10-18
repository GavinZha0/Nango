# Skills

> Audience: backend / frontend engineers, contributors authoring skills
> See also: `docs/rbac.md`, `docs/architecture.md`, `docs/builtin-runtime.md`,
> `docs/ssh.md`

Skills are reusable, **DB-resident** capabilities a built-in agent can load
on demand via [progressive disclosure](#1-progressive-disclosure). Each
skill is one row in the `skill` table plus zero-or-more rows in
`skill_file`.

There is **one kind of skill**: user-authored or imported. Every row is
created through the UI / API or a `.skill` ZIP import, and is subject to
RBAC × visibility × ownership rules (see `docs/rbac.md`). `source` is a
free-form origin label (e.g. `"anthropic"`, `"skills.sh"`), not a
built-in/custom switch; empty string means unlabeled.

There is **no filesystem storage** at runtime. No `$NANGO_SKILLS_HOME`,
no `fs.watch`, no path-traversal defenses. The on-disk `<repo>/skills/`
tree was an authoring view for a built-in pipeline that no longer exists;
the runtime never reads it.

---

## 1. Progressive disclosure

When a built-in agent has skills bound to it, the runtime injects only
metadata (name + description) into the agent's system prompt:

```
## Available Skills

- csv-data-summary: Summarize a CSV file with per-column statistics ...
- pdf-extractor: ...
```

When a user request matches a skill, the model calls one of the
server-side tools to load the actual content:

| Tool | What it returns |
|---|---|
| `get_skill(name)` | The full SKILL.md text (frontmatter + body) |
| `get_skill_file(name, path)` | A helper file from the skill's tree, in any folder |
| `run_skill_script(name, filename, datasets?)` | Execute a script bundled with the skill in the same sandbox as `run_code_in_sandbox`. A bare filename resolves under `scripts/`; a relative path (e.g. `bin/analyze.py`) resolves as-is. Interpreter dispatched by extension (V1: `.py` → python3, `.sh` → bash). `stdin` is NOT exposed as a parameter — script source bytes go through stdin internally and cannot be overridden. Scripts declared in `scripts-on-ssh` are refused here: `SSH_SCRIPT` when `run_skill_script_on_ssh` is mounted, `SSH_NOT_AVAILABLE` (with a "bind an SSH host" hint) when the agent has no `ssh_server` binding. They are never silently downgraded to the sandbox, because a host-targeted script run locally reports the sandbox instead of the target. |
| `run_skill_script_on_ssh(name, filename, serverName, args?, timeoutSeconds?)` | Execute a reviewed script declared in `scripts-on-ssh` on a bound SSH host. Dispatched via `runOnBoundServer` subject to server allow/deny policy. Bash (`.sh`) passes skill name as `$0` and args as `$1..`; Python (`.py`) passes args as `sys.argv[1:]`. Command capped at 16,000 characters, measured by `runOnBoundServer` on the string that actually reaches `sshd` (login-shell wrapping included), so `COMMAND_TOO_LONG` never fires after the channel is open. Script bytes are decoded with a fatal `TextDecoder` — invalid UTF-8 or NUL bytes return `INVALID_SCRIPT_BYTES` instead of executing mojibake; a leading BOM is stripped. |

Token cost is bounded by the description list, not by the full skill
bodies. `run_skill_script_on_ssh` is mounted only when **both** at least
one bound skill declares `scripts-on-ssh` **and** the agent has at least
one bound `ssh_server`.

---

## 2. Data model

### 2.1 `skill` table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid v4 | URL-exposed; FK target for `builtin_agent_tool.skill_id` |
| `name` | text | Kebab-case slug, mirrors the SKILL.md `name:` frontmatter field. Synced on every content write. |
| `description` | text | Parsed from frontmatter |
| `version` | text | Parsed from frontmatter; default `1.0.0`; informational |
| `skill_md` | text | Full SKILL.md text (frontmatter + body) |
| `source` | text | Free-form user-set origin label (≤ 200 chars at the API edge); `""` = unlabeled. Carries no semantics. |
| `enabled` | boolean | UI on/off toggle |
| `visibility` | `'private' \| 'public'` | RBAC scope |
| `created_by` | uuid → user | FK SET NULL on user purge |
| `updated_by` | uuid → user | RBAC audit field, refreshed on every write |
| `created_at` / `updated_at` | timestamp | Standard |

The frontmatter `name:` is the single source of truth for a skill's
name. The `Name` input was removed from the editor; renaming happens by
editing the frontmatter. On write the server re-parses SKILL.md and
syncs `skill.name`, `skill.description`, and `skill.version`. Renaming is
supported; a rename colliding with another skill owned by the same
creator returns 409.

### 2.2 `skill_file` table

| Column | Type | Notes |
|---|---|---|
| `id` | bigint | Primary key |
| `skill_id` | uuid | FK to `skill(id)` ON DELETE CASCADE |
| `path` | text | Relative POSIX path (e.g. `references/output.md`). Must live under a top-level folder; the folder name itself is free-form. |
| `content` | bytea | Raw bytes (≤ 256 KB) |
| `size` | integer | File size |
| `content_type` | text | MIME type |
| `updated_at` | timestamp | Last modified |

**Path semantics**: `path` is a **relative POSIX path** with at least two
segments — a top-level folder plus a filename. Folder names are
free-form because skill authors do not agree on them (`references/`,
`lib/`, `rules/`, `templates/`, …); a ZIP import keeps whatever layout
the archive ships:

```
<any-folder>/...
```

Validated by regex on every write. Parent-directory traversal (`..`),
absolute paths, back-slashes, dotfiles, and root-level files are
rejected — the last two are skipped silently at import time as archive
noise rather than failing the upload. There is no actual filesystem to
traverse — `path` is only a string used as a logical locator for
`get_skill_file(name, path)`.

**Content storage**: `bytea`. Postgres TOASTs and compresses
automatically. The 256 KB per-file cap is enforced at write time
(matches the runtime tool's `MAX_FILE_BYTES`).

**Total caps** (enforced at write):

| Limit | Value | Where checked |
|---|---|---|
| `path` length | 256 chars | API validation |
| File count per skill | 100 | API validation |
| Single file size | 256 KB | API validation |
| Total skill size | 10 MB | API validation |

Caps are config-backed (`skill.max_file_bytes`, `skill.max_files`,
`skill.max_total_bytes`) and shared with the import pipeline.

---

## 3. Authoring a skill

Skills are authored as directory trees, identical to the Anthropic
Claude Skills convention, then uploaded as a `.skill` (ZIP) archive or
created as a single SKILL.md through the editor:

```
my-skill/
├── SKILL.md                          # required
├── references/
│   └── output-format.md
├── scripts/
│   └── summarize.py
├── assets/
│   └── template.html
└── evals/                            # optional, stored as-is
```

### 3.1 SKILL.md format

```markdown
---
name: csv-data-summary
description: Summarize a CSV file with per-column statistics. Use when ...
version: 1.2.0
---

# CSV Data Summary

Procedure ...

## When to use this skill ...
```

| Frontmatter field | Required | Validation |
|---|---|---|
| `name` | yes | Kebab-case `[a-z0-9][a-z0-9_-]{0,63}`; unique per creator |
| `description` | yes | 10–1000 chars |
| `version` | no | Free-form string; default `'1.0.0'` |
| `context` | no | Skills 2.0 spec field; parsed but unused in v1 |
| `allowed-tools` | no | Skills 2.0 spec field; parsed but unused in v1 |
| `scripts-on-ssh` | no | String or array of script filenames under `scripts/` (e.g. `['probe.sh']`). Aliases: `scripts_on_ssh`, `scriptsOnSsh`. Normalized to `scripts/<file>`. Requires `.py` or `.sh`. Sub-directories forbidden. Import fails if the declared file is missing or is not valid UTF-8; PATCH checks existence only (the bytes were already gated at import). |
| Other fields | no | Captured into `extras`, not consumed |

`dependencies-python` is no longer parsed. Sandbox packages are
hand-maintained in `docker/dify-sandbox/requirements.txt`; a skill's
frontmatter declarations are advisory only.

---

## 4. Skill lifecycle

### 4.1 Editor flow (UI)

`/skills/[id]` page (mirrors `/agent/[id]` and `/schedule/[id]`):

| Action | Endpoint | RBAC |
|---|---|---|
| Create | `POST /api/skills` body `{ skillMd, visibility?, source? }` | `withEditor` |
| Read | `GET /api/skills/:id` returns row + `files` + `scriptsOnSsh` + `missingSshScripts` | `withSession` (visibility-filtered) |
| Update content / source | `PATCH /api/skills/:id` body `{ skillMd?, source?, enabled?, visibility? }` | `withEditor` + `canEditResource` |
| Delete | `DELETE /api/skills/:id` | `withEditor` + `canDeleteResource` |
| List | `GET /api/skills` | `withSession` (visibility-filtered) |
| File read | `GET /api/skills/:id/files/[...path]` | `withSession` (parent skill visibility-filtered) |

`POST /api/skills` writes only the `skill` row. **`POST /api/skills/import` is
the sole writer of `skill_file`** — the file endpoint is read-only, so a
hand-created skill can never acquire helper scripts after the fact. Editing a
script means re-importing under a new name (import never updates in place).

The write boundaries validate `scripts-on-ssh` against the files that actually
exist, because a dangling declaration is invisible until
`run_skill_script_on_ssh` fails on a remote host:

| Boundary | Judged against | Outcome |
|---|---|---|
| `POST /api/skills/import` | In-memory ZIP entries | 400 before any write |
| `POST /api/skills` | Nothing — a created row has no files | 400 |
| `PATCH /api/skills/:id` | `storage.listFiles(id)` | 400, body untouched |
| `GET /api/skills/:id` | `storage.listFiles(id)` | `missingSshScripts: string[]` for pre-existing rows |

Declared scripts must additionally be valid UTF-8 text, because their source is
embedded in a command string and executed on a remote host. The same pure
helper (`src/lib/skills/ssh-script-source.ts`) gates the import (400) and
dispatch (`INVALID_SCRIPT_BYTES`). `PATCH` checks existence only — re-reading
every stored script on each save is not worth it when the bytes were already
gated at import.

The editor lets the user edit `SKILL.md` directly, edit the free-form
`Source` label, and preview helper files in any folder. File upload is not a
write surface: helper files arrive only through ZIP import.

### 4.2 Renaming

PATCH allows the frontmatter `name:` to change. The route re-parses the new
SKILL.md and checks for a clash on `(name, createdBy)` excluding the row
itself; a clash returns 409. `updateContent` writes the new name into the
`skill.name` column in the same statement as the body, so list queries and
name-based lookups stay consistent. Agent bindings use `skillId`, so renaming
does not orphan `builtin_agent_tool` rows.

### 4.3 ZIP import

```
POST /api/skills/import    multipart/form-data file=<archive.skill>
                           withEditor
```

`.skill` is a ZIP archive. Server-side:

```
1. Read upload to memory (cap: 10 MB total).
2. Open as ZIP. Reject if invalid.
3. For each entry:
     - reject absolute paths, '..' segments, back-slashes
     - reject symlinks (zip external_attr stat)
     - skip archive noise (root-level files, dotfiles) — folder names
       themselves are free-form
     - track total size; bail if > 10 MB
4. Locate SKILL.md (root or single nested folder).
5. Parse + validate frontmatter.
6. Reject if the creator already owns a skill with the same name (409).
7. Persist the skill row, then helper-file rows at their archive paths.
8. Return the new row's id.
```

Import does not auto-fill `source`; the new row starts unlabeled and the
user can set a label in the editor. The resulting row is a normal skill:
listed in `/skills`, editable, and deletable like any other row.

What's "in-memory only" is the **ZIP processing pipeline**, not the resulting
skill: the upload is parsed entirely as Buffers + strings without ever writing
temp files to the host filesystem. This is a security property (zero attack
surface for path traversal — there is no fs target to traverse to), not a
persistence claim. Memory bounds: `Content-Length` ≤ 10 MB hard cap on the
upload, plus per-entry uncompressed size accounting during decode to defeat
zip-bomb amplification.

The `.skill` format is the same ZIP layout DeerFlow uses, so packs
created elsewhere can be imported directly.

---

## 5. RBAC integration

The full rules live in `docs/rbac.md` §2.2. For skills specifically:

```
canView = visibility=='public' OR createdBy==self OR isAdmin
canEdit = isEditorOrAdmin AND (visibility=='public' OR createdBy==self)
canDelete = createdBy==self OR isAdmin
canChange = canDelete   // visibility / enabled gate
```

`source` is not part of any permission decision — it is a display label.
`updatedBy` is set automatically on every PATCH. Listing uses
`visibilitySql()` from `lib/auth/permissions.ts`.

---

## 6. Runtime caches

Two caches participate in the skills hot path:

| Pool | Keyed by | Module | Purpose |
|---|---|---|---|
| `agentPool` | agentId | `lib/builtin-agents/agent-pool.ts` | Per-agent decoded `AgentSpec`, includes `[skillId, ...]` references |
| `skillPool` | skillId | `lib/skills/skill-pool.ts` | Per-skill `SkillSpec` (skillMd + parsed frontmatter + metadata) |

Both are LRU + 10-min TTL (configurable via `cache.skill_pool.*`). After every
skill mutation (`POST` / `PATCH` / `DELETE` / ZIP import), the write path calls
`invalidateForSkillChange(skillId)` which:

1. Drops the cached `SkillSpec` from `skillPool`.
2. Reverse-queries `builtin_agent_tool` for every agent binding this
   skill and invalidates each one in `agentPool`.

`get_skill_file` performs a direct DB lookup on every call (no file
cache); the rationale is that helper files are large, infrequently
accessed, and one round-trip to PG with a hot connection is ~1ms.

---

## 7. When NOT to use a skill

Skills are great for:

- Procedures that several agents share (e.g. CSV profiling, report
  generation).
- Instructions referenceable by any agent without duplicating the
  system prompt.
- Multi-file capabilities (templates, examples, scripts).

Skills are the **wrong** tool when:

- The capability is a single API call → use an MCP tool.
- The capability needs cross-turn state → use a backend agent
  platform (agno / Mastra) instead.
- The capability needs a fresh runtime sandbox → wait for the
  forked-context / sandboxed-execution version.
- The capability needs ad-hoc interactive remote commands → use
  `run_ssh_command`. However, when structured diagnostic or operational
  scripts are versioned as part of a skill, declare them in
  `scripts-on-ssh` and execute them via `run_skill_script_on_ssh` on a
  bound SSH host.

---

## 8. Implementation details and quirks

### 8.1 Why `bytea` for content

Postgres TOAST handles values up to ~1 GB and auto-LZ4-compresses them
above ~2 KB. With a 256 KB hard cap and ~50–100 skills × ≤ 100 files
each, even a worst-case dataset is tens of MB — trivial. Blob storage
in PG is not the anti-pattern it's reputed to be at this scale.

### 8.2 Skill identity

Skills are identified by `(id)` (URL-stable). Names are unique per
creator and are expected to match the SKILL.md frontmatter, but the id
is what agent bindings and caches use.

### 8.3 ZIP import isn't path traversal

`skill_file.path` is a **string column**, not a filesystem path. A
hostile ZIP entry named `../../etc/passwd` would simply fail the regex
validation; it cannot reach the host filesystem because no extraction
to disk ever happens. `.skill` packs are *processed* entirely in
memory and *persisted* into `skill` + `skill_file` rows like any
other custom skill — no fs side effect at any stage.

### 8.4 Caching `get_skill_file` is unnecessary

A single `SELECT content FROM skill_file WHERE skill_id = ? AND path = ?`
on a 4-byte-keyed unique index is sub-millisecond on a warm
connection. Cache hit ratio for helper files is intrinsically low
(model loads them on demand, then doesn't revisit). Adding an LRU
here would optimize ~5% of calls at the cost of cache-coherence
bookkeeping.

---

## 9. Future work

- **Languages beyond .py / .sh** — V1 dispatch table covers python3
  and bash only; adding e.g. `.js` / `.ts` requires a row in
  `INTERPRETER_BY_EXTENSION` AND the binary present in the sandbox
  rootfs.
- **Editing helper files in place** — helper files are still immutable
  after import; a future file-write endpoint would need the same caps
  and path validation as the ZIP importer.
