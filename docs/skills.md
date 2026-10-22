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
| `run_skill_script(name, filename, datasets?)` | Execute a script bundled with the skill in the same sandbox as `run_code_in_sandbox`. A bare filename resolves under `scripts/`; any relative path must also be under `scripts/` (e.g. `scripts/lib/analyze.py`). Executable scripts outside `scripts/` are refused with `SCRIPT_OUTSIDE_SCRIPTS`. Interpreter dispatched by extension (V1: `.py` → python3, `.sh` → bash). `stdin` is NOT exposed as a parameter — script source bytes go through stdin internally and cannot be overridden. Scripts declared in `scripts-on-ssh` are refused here: `SSH_SCRIPT` when `run_skill_script_on_ssh` is mounted, `SSH_NOT_AVAILABLE` (with a "bind an SSH host" hint) when the agent has no `ssh_server` binding. They are never silently downgraded to the sandbox, because a host-targeted script run locally reports the sandbox instead of the target. |
| `run_skill_script_on_ssh(name, filename, serverName, args?, timeoutSeconds?)` | Execute a reviewed script declared in `scripts-on-ssh` on a bound SSH host. Declared paths may be nested under `scripts/` (e.g. `scripts/lib/probe.sh`). Dispatched via `runOnBoundServer` subject to server allow/deny policy. Bash (`.sh`) passes skill name as `$0` and args as `$1..`; Python (`.py`) passes args as `sys.argv[1:]`. Command capped at 16,000 characters, measured by `runOnBoundServer` on the string that actually reaches `sshd` (login-shell wrapping included), so `COMMAND_TOO_LONG` never fires after the channel is open. Script bytes are decoded with a fatal `TextDecoder` — invalid UTF-8 or NUL bytes return `INVALID_SCRIPT_BYTES` instead of executing mojibake; a leading BOM is stripped. |
| `run_skill_sql_script(name, filename, dataSourceName, datasetName, rowLimit?, forceRefresh?)` | Execute a reviewed `.sql` file declared in `scripts-on-db` against a bound data source. Reads the file server-side (never accepts raw SQL), validates single-statement SQL and the data-source policy, then reuses `extract_dataset_by_sql`'s DuckDB + Parquet cache path. Returns the extract result plus `skill`, `script`, `scriptSha256`, `dataSourceName`. For ad-hoc or modified SQL, use `extract_dataset_by_sql` instead. |

Token cost is bounded by the description list, not by the full skill
bodies. `run_skill_script_on_ssh` is mounted only when **both** at least
one bound skill declares `scripts-on-ssh` **and** the agent has at least
one bound `ssh_server`. `run_skill_sql_script` is mounted only when
**both** at least one bound skill declares `scripts-on-db` **and** the
agent has at least one bound data source.

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

**Path semantics**: `path` is a **relative POSIX path** with one or more
segments. Root-level files such as `LICENSE` are valid; other files usually
live in author-defined folders (`references/`, `scripts/`, `lib/`, `rules/`,
`templates/`, …), and a ZIP import keeps whatever layout the archive ships:

```
<any-folder>/...
LICENSE
```

Validated by regex on every write. Parent-directory traversal (`..`),
absolute paths, back-slashes, and dotfiles are rejected. The synthetic root
`SKILL.md` is reserved. Folders are implicit: they exist only while at least
one file lives under them. There is no actual filesystem to traverse — `path`
is only a string used as a logical locator for `get_skill_file(name, path)`.

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
| `scripts-on-ssh` | no | String or array of file paths under `scripts/` (e.g. `['probe.sh']` or `['lib/probe.sh']`). Aliases: `scripts_on_ssh`, `scriptsOnSsh`. Normalized to `scripts/<path>`; sub-directories are allowed. Extensions are not restricted: only `.py` / `.sh` are executable, and other declared files return `UNSUPPORTED_INTERPRETER` at runtime. Import fails if the declared file is missing or is not valid UTF-8; PATCH checks existence only (the bytes were already gated at import). |
| `scripts-on-db` | no | String or array of `.sql` file paths under `scripts/` (e.g. `['reports/sales.sql']`). Aliases: `scripts_on_db`, `scriptsOnDb`. Normalized to `scripts/<path>.sql`; sub-directories are allowed. Declared files are executed by `run_skill_sql_script` against a bound data source. Import/PATCH reject missing files; the editor shows `missingDbScripts` for legacy rows. |
| Other fields | no | Captured into `extras`, not consumed |

`dependencies-python` is no longer parsed. Sandbox packages are
hand-maintained in `docker/dify-sandbox/requirements.txt`; a skill's
frontmatter declarations are advisory only.

### 3.2 SQL scripts (`scripts-on-db`)

SQL files are reviewed queries, not arbitrary model-authored SQL:

```yaml
---
name: sales-report
description: ...
scripts-on-db: ["reports/quarterly.sql"]
---
```

Constraints:

- `.sql` only, under `scripts/` (subdirectories allowed).
- Single `SELECT` / `WITH` statement. `extractViaDuckdb` wraps the query in
  `COPY (<sql>) TO '<parquet>'`, so multi-statement scripts, DDL/DML, and
  procedure bodies are rejected.
- No bound parameters in V1; bake values into the query or use
  `get_skill_file` + `extract_dataset_by_sql` for a modified query.
- The file must be UTF-8 without NUL bytes.
- A declared file must exist; rename/delete keeps `scripts-on-db` in sync
  (renaming to a non-`.sql` extension removes the entry with a warning).

Tool routing with a data source bound:

1. A declared SQL file → `run_skill_sql_script(name, filename, dataSourceName, datasetName)`.
2. Ad-hoc or modified SQL → `extract_dataset_by_sql`.
3. Both share the data-source policy and the Parquet cache slot semantics.

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
| File create | `POST /api/skills/:id/files` body `{ parentFolder, name, content? }` | `withEditor` + `canEditResource` |
| File rename / text edit | `PATCH /api/skills/:id/files/[...path]?kind=file\|folder` body `{ name?, content? }` | `withEditor` + `canEditResource` |
| File delete | `DELETE /api/skills/:id/files/[...path]?kind=file\|folder` | `withEditor` + `canEditResource` |

`POST /api/skills` writes only the `skill` row. Helper files can be created,
edited, renamed, and deleted through the file endpoints; **`POST
/api/skills/import` remains the only way to add binary assets**. Text helper
files are edited in the main pane; binary files are rename/delete-only.

Parent folders are derived from file paths. The Add dialog offers the root,
every existing folder, and a "+ Create new folder..." option; choosing the
latter creates the folder implicitly with the new file. No empty folders are
stored, so deleting the last file under a folder removes the folder node.

The write boundaries validate `scripts-on-ssh` against the files that actually
exist, because a dangling declaration is invisible until
`run_skill_script_on_ssh` fails on a remote host:

| Boundary | Judged against | Outcome |
|---|---|---|
| `POST /api/skills/import` | In-memory ZIP entries | 400 before any write |
| `POST /api/skills` | Nothing — a created row has no files | 400 |
| `PATCH /api/skills/:id` | `storage.listFiles(id)` | 400, body untouched |
| `GET /api/skills/:id` | `storage.listFiles(id)` | `missingSshScripts: string[]` for pre-existing rows |
| File rename/delete under `scripts/` | Parsed `scripts-on-ssh` | Declaration rewritten in the same transaction |
| Rename top-level `scripts/` | — | 400; the folder is reserved |

Declared scripts must additionally be valid UTF-8 text, because their source is
embedded in a command string and executed on a remote host. The same pure
helper (`src/lib/skills/ssh-script-source.ts`) gates the import (400) and
dispatch (`INVALID_SCRIPT_BYTES`). `PATCH` checks existence only — re-reading
every stored script on each save is not worth it when the bytes were already
gated at import.

The editor lets the user edit `SKILL.md` and text helper files in the main
pane, edit the free-form `Source` label, and preview binary files read-only.
Switching files while the current file is dirty opens a Save / Ignore dialog,
so at most one file is edited at a time. The tree exposes hover rename/delete
actions for files and folders; the synthetic `SKILL.md` node has none. Deleting
a folder removes every descendant file after confirmation.

### 4.2 Renaming

**Skill name**: PATCH allows the frontmatter `name:` to change. The route
re-parses the new SKILL.md and checks for a clash on `(name, createdBy)`
excluding the row itself; a clash returns 409. `updateContent` writes the new
name into the `skill.name` column in the same statement as the body, so list
queries and name-based lookups stay consistent. Agent bindings use `skillId`,
so renaming does not orphan `builtin_agent_tool` rows.

**Files and folders**: the tree's Edit action opens a rename-only dialog. File
renames change the basename; folder renames update every descendant path in a
transaction. A rename that would collide with an existing file/folder returns
409. Deleting the last file under a folder removes the folder node.

**`scripts-on-ssh` sync**: renaming a file or a folder under `scripts/`
rewrites every affected declaration to the new path in the same transaction
as the file-path update. Renaming a file outside `scripts/` does not touch
declarations. Non-executable targets are allowed and keep the declaration;
`run_skill_script_on_ssh` reports `UNSUPPORTED_INTERPRETER` if invoked.
Deleting a declared file or a folder under `scripts/` removes the affected
declarations; deleting the top-level `scripts/` folder removes every
declaration under it. The top-level `scripts/` folder itself cannot be
renamed because declarations must stay under `scripts/`.

**`scripts-on-db` sync**: renaming a declared `.sql` file or a folder that
contains one rewrites the affected `scripts-on-db` entries in the same
transaction. Renaming a declared SQL file to a non-`.sql` extension removes
the declaration with a warning (keeping it would make SKILL.md unparseable).
Deleting a declared SQL file or folder removes the affected entries. The
same file rename/delete path updates `scripts-on-ssh` and `scripts-on-db`
together.

Executable scripts created or renamed through the editor must live under
`scripts/` (subfolders are allowed); `.py` / `.sh` files elsewhere are
rejected. Imported archives may still contain `.py` / `.sh` reference files
outside `scripts/`, but they are not executable.

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
     - classify the path (see §4.4):
         ignored -> skip and report
         blocked -> reject the whole import with a 400 + reasons
         allowed -> keep (text/code/docs or images)
     - reject text files containing NUL bytes
     - verify image magic bytes match the extension
     - track total size; bail if > 10 MB
4. Locate SKILL.md (root or single nested folder).
5. Parse + validate frontmatter, including scripts-on-ssh / scripts-on-db
   declarations backed by files in the same bundle.
6. Reject if the creator already owns a skill with the same name (409).
7. Persist the skill row, then helper-file rows at their archive paths.
8. Return the new row's id plus `filesImported` and `skipped`.
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

### 4.4 Import file policy

The open Agent Skills spec permits any file, but Nango can only execute
`.py` / `.sh` scripts and preview images. Import therefore uses an allowlist
(`src/lib/skills/import-policy.ts`):

| Action | File types | Behavior |
|---|---|---|
| **Allow — text** | `md, markdown, txt, json, jsonl, ipynb, yaml, yml, toml, ini, cfg, conf, csv, tsv, xml, sql, py, pyi, sh, bash, zsh, js, mjs, cjs, ts, tsx, jsx, css, html, svg, rst, tex`, plus extensionless text files (`LICENSE`, `README`, `Dockerfile`, `Makefile`) | Imported after a NUL-byte check |
| **Allow — image** | `png, jpg, jpeg, gif, webp, ico` | Imported after magic-byte validation; the editor previews them |
| **Ignore** | dotfiles/dot-directories, generated caches/build metadata, OS/editor metadata, root `SKILL.md` | Skipped and returned in `skipped: string[]`; import succeeds |
| **Block** | executables/native binaries (`exe, dll, so, dylib, bin, msi, bat, cmd, ps1, jar, wasm, …`), audio/video, archives, fonts, PDF/Office documents, binary data/models, unknown extensions | Import fails with 400 and a path-by-path reason list; no rows are written |

`.bash` / `.zsh` are imported as reference text; only `.py` / `.sh` under
`scripts/` are executable.

Generated noise ignored by default (matched at any depth):

- Python: `__pycache__/`, `*.pyc`, `*.pyo`, `venv/`, `virtualenv/`,
  `__pypackages__/`, `*.egg-info/`, `*.dist-info/`, `*.whl`, `*.egg`
- JS/tooling: `node_modules/`, `*.tsbuildinfo`, `*.map`, `*.lock`, `*.lockb`
- Logs/temp/editor: `*.log`, `*.tmp`, `*.temp`, `*.bak`, `*.orig`, `*.rej`,
  `*.swp`, `*.swo`, `*~`, `*.iml`, `*.suo`
- OS metadata: `__MACOSX/`, `Thumbs.db`, `desktop.ini`, `ehthumbs.db`

Dot-prefixed directories such as `.git/`, `.idea/`, `.vscode/`, `.venv/`,
`.pytest_cache/`, and `.mypy_cache/` are already covered by the dotfile rule.

Rationale: Nango has no Windows/native executor, no skill-file materialization
into the sandbox or SSH host, and no binary parser. An `.exe` or `.dll` stored
in a skill is inert, while still being a malware-distribution liability.
Windows executables should be exposed through an MCP server on the Windows
host; the skill documents how to call that tool.

The same policy drives editor creation (text only) and rename (text or image;
the existing bytes must match the new type). Images can be imported but not
created or downloaded from the editor.

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
- **Binary editing** — binary assets are still import-only; the editor
  intentionally offers no binary upload or download.
