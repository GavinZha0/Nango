# Skills

> Audience: backend / frontend engineers, contributors authoring built-in skills
> See also: `docs/rbac.md`, `docs/architecture.md`, `docs/builtin-runtime.md`

Skills are reusable, **DB-resident** capabilities a built-in agent can load
on demand via [progressive disclosure](#progressive-disclosure). Each
skill is one row in the `skill` table plus zero-or-more rows in
`skill_file`.

There are **two kinds** of skills:

| Kind | `source` | Origin | Mutability | Visibility default |
|---|---|---|---|---|
| **Built-in** | `'builtin'` | Authored in `<repo>/skills/`, baked into `dist/builtin-skills.json` at build time, reconciled into DB at boot | Read-only via API (any role); changes go through code review + redeploy | `'public'` |
| **Custom** | `'local'` | Created by admin / editor through the UI editor or by uploading a `.skill` archive | Subject to RBAC × visibility × ownership rules (see `docs/rbac.md`) | `'private'` |

The two kinds share the same table. The `source` column is the
write-protection switch — `source = 'builtin'` rows can never be
mutated through the API, regardless of role.

There is **no filesystem storage** at runtime. No `$NANGO_SKILLS_HOME`,
no `fs.watch`, no path-traversal defenses. The on-disk
`<repo>/skills/` tree is purely a developer-authoring view; the
runtime never reads it.

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
| `get_skill_file(name, path)` | A helper file under `references/`, `scripts/`, `assets/`, or `evals/` |
| `run_skill_script(name, filename, datasets?)` | Execute a script from the skill's `scripts/` tree in the same sandbox as `run_code_in_sandbox`. Interpreter dispatched by extension (V1: `.py` → python3, `.sh` → bash). `stdin` is NOT exposed as a parameter — script source bytes go through stdin internally and cannot be overridden. |

Token cost is bounded by the description list, not by the full skill
bodies.

---

## 2. Data model

### 2.1 `skill` table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid v4 | URL-exposed; FK target for `builtin_agent_tool.skill_id` |
| `name` | text | Kebab-case slug, must equal the SKILL.md `name:` frontmatter field |
| `description` | text | Parsed from frontmatter |
| `version` | text | Parsed from frontmatter; default `1.0.0`; informational |
| `skill_md` | text | Full SKILL.md text (frontmatter + body) |
| `checksum` | text | sha256 of the canonical bundle content; used by reconcile to skip no-op updates |
| `source` | `'builtin' \| 'local'` | Hard write-protection for `'builtin'` |
| `enabled` | boolean | UI on/off toggle |
| `visibility` | `'private' \| 'public'` | RBAC scope |
| `created_by` | uuid → user | FK SET NULL on user purge |
| `updated_by` | uuid → user | RBAC audit field, refreshed on every write |
| `created_at` / `updated_at` | timestamp | Standard |

### 2.2 `skill_file` table

| Column | Type | Notes |
|---|---|---|
| `id` | bigint | Primary key |
| `skill_id` | uuid | FK to `skill(id)` ON DELETE CASCADE |
| `path` | text | Relative POSIX path (e.g. `references/output.md`). Validated prefixes: `references/`, `scripts/`, `assets/`, `evals/`. |
| `content` | bytea | Raw bytes (≤ 256 KB) |
| `size` | integer | File size |
| `content_type` | text | MIME type |
| `updated_at` | timestamp | Last modified |

**Path semantics**: `path` is a **relative POSIX path** matching one of
the four allowed prefixes:

```
references/...
scripts/...
assets/...
evals/...
```

Validated by regex on every write. Parent-directory traversal (`..`),
absolute paths, and back-slashes are rejected. There is no actual
filesystem to traverse — `path` is only a string used as a logical
locator for `get_skill_file(name, path)`.

**Content storage**: `bytea`. Postgres TOASTs and compresses
automatically. The 256 KB per-file cap is enforced at write time
(matches the runtime tool's `MAX_FILE_BYTES`).

**Total caps** (enforced at write):

| Limit | Value | Where checked |
|---|---|---|
| `path` length | 256 chars | API validation |
| File count per skill | 100 | API validation + bundle build |
| Single file size | 256 KB | API validation + bundle build |
| Total skill size | 10 MB | API validation + bundle build |

---

## 3. Built-in skill publishing pipeline

```
<repo>/skills/                                ← source view (developer)
  csv-data-summary/
    SKILL.md
    references/output-format.md
    scripts/summarize.py
    assets/template.html

      │  pnpm build:skills  (prebuild hook)
      ▼

dist/builtin-skills.json                      ← build artifact (in image)

      │  on container start: seedBuiltinSkills()
      ▼

skill rows (source='builtin') + skill_file rows   ← runtime SOT
```

### 3.1 Authoring built-in skills

Developers write skills as directory trees, identical to the Anthropic
Claude Skills convention:

```
<repo>/skills/csv-data-summary/
├── SKILL.md                          # required
├── references/
│   └── output-format.md
├── scripts/
│   └── summarize.py
├── assets/
│   └── template.html
└── evals/                            # optional, parsed only
```

PR review sees the directory tree as one would for any code change.
There is **no `.builtin-manifest.json`** — every directory under
`<repo>/skills/` that has a valid `SKILL.md` is automatically a
built-in candidate.

### 3.2 SKILL.md format

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
| `name` | yes | Kebab-case `[a-z0-9][a-z0-9_-]{0,63}`; must equal directory name (built-in) or unique within source (custom) |
| `description` | yes | 10–1000 chars |
| `version` | no | Free-form string; default `'1.0.0'` |
| `context` | no | Skills 2.0 spec field; parsed but unused in v1 |
| `allowed-tools` | no | Skills 2.0 spec field; parsed but unused in v1 |
| Other fields | no | Captured into `extras`, not consumed |

### 3.3 Build script (`scripts/build-skills.ts`)

Run as `pnpm build:skills`, hooked to `prebuild`:

1. Walk `<repo>/skills/`. Each subdirectory with a `SKILL.md` is a
   candidate.
2. Parse and validate `SKILL.md` frontmatter. **Fail the build** on any
   error (broken frontmatter must be fixed in PR, never escape into
   prod).
3. Read every file under `references/` `scripts/` `assets/` `evals/`.
   Skip `.DS_Store`, `__MACOSX`, dotfiles, `node_modules`, anything not
   in those four subdirectories.
4. Enforce: file size ≤ 256 KB, count ≤ 100, total ≤ 10 MB. Detect
   text vs binary by NUL-byte heuristic (matching runtime `isLikelyText`).
5. Sort files by path for canonical output, then compute
   `sha256(skillMd + canonical(files))`.
6. Emit `dist/builtin-skills.json`.

#### Bundle JSON format

```jsonc
{
  "$schema": "nango/builtin-skills@1",
  "generatedAt": "2026-05-04T12:34:56.000Z",
  "skills": [
    {
      "name": "csv-data-summary",
      "version": "1.2.0",
      "description": "Summarize a CSV file with per-column statistics ...",
      "checksum": "sha256:abc123...",
      "skillMd": "---\nname: csv-data-summary\n...",
      "files": [
        {
          "path": "references/output-format.md",
          "size": 1234,
          "contentType": "text/markdown",
          "encoding": "utf8",
          "content": "# Output format\n..."
        },
        {
          "path": "scripts/summarize.py",
          "size": 567,
          "contentType": "text/x-python",
          "encoding": "utf8",
          "content": "import csv\n..."
        },
        {
          "path": "assets/template.html",
          "size": 8910,
          "contentType": "text/html",
          "encoding": "utf8",
          "content": "<html>..."
        }
        // Binary assets use base64:
        // {
        //   "path": "assets/logo.png",
        //   "size": 4096,
        //   "contentType": "image/png",
        //   "encoding": "base64",
        //   "content": "iVBORw0KGgo..."
        // }
      ]
    }
  ]
}
```

### 3.4 Boot-time reconcile (`seedBuiltinSkills`)

Called once per Node process from `instrumentation.ts` (lazy on first
use is also acceptable). Runs in a single transaction:

```ts
async function seedBuiltinSkills() {
  const bundle = JSON.parse(await fs.readFile("dist/builtin-skills.json"));
  const inDb  = await db.select(...).from(skill).where(eq(skill.source, "builtin"));
  const inDbByName = new Map(inDb.map(r => [r.name, r]));
  const inBundle   = new Set(bundle.skills.map(s => s.name));

  await db.transaction(async tx => {
    for (const s of bundle.skills) {
      const row = inDbByName.get(s.name);
      if (row && row.checksum === s.checksum) continue;          // unchanged
      if (row) await updateBuiltinRow(tx, row.id, s);            // checksum changed → upsert
      else     await insertBuiltinRow(tx, s);                    // new builtin
    }
    // Builtin removed from bundle → soft-disable, do NOT delete the row
    // (preserve agent bindings; admin can revisit).
    for (const row of inDb) {
      if (!inBundle.has(row.name) && row.enabled) {
        await tx.update(skill).set({ enabled: false }).where(eq(skill.id, row.id));
      }
    }
  });
}
```

Key invariants:

1. **Built-in row IDs are stable**. Reconcile finds existing rows by
   `(source='builtin', name)`. The UUID never regenerates, so
   `builtin_agent_tool.skill_id` references survive every redeploy.
2. **Removed built-ins are not deleted** — they're disabled. Agents
   that used to bind them keep their config; admin can repoint.
3. **Custom rows (`source='local'`) are never touched** by reconcile.
4. **Cheap on warm starts**: 99% of skills have unchanged checksum, so
   the transaction is a small sequence of no-op SELECTs.

---

## 4. Custom skill lifecycle

### 4.1 Editor flow (UI)

`/skills/[id]` page (mirrors `/agent/[id]` and `/schedule/[id]`):

| Action | Endpoint | RBAC |
|---|---|---|
| Create | `POST /api/skills` body `{ skillMd, visibility?, files? }` | `withEditor` |
| Read | `GET /api/skills/:id` returns row + files metadata | `withSession` (visibility-filtered) |
| Update content | `PATCH /api/skills/:id` body `{ skillMd?, files?, ... }` | `withEditor` + `canEditResource` |
| Update flag | `PATCH /api/skills/:id` body `{ enabled?, visibility? }` | `withEditor` + `canChangeVisibility` |
| Delete | `DELETE /api/skills/:id` | `withEditor` + `canDeleteResource` |
| List | `GET /api/skills` | `withSession` (visibility-filtered) |
| File read | `GET /api/skills/:id/files/[...path]` | `withSession` (parent skill visibility-filtered) |

The editor lets the user edit `SKILL.md` directly; helper files
(references / scripts / assets) get a separate upload widget — file
upload lands as a write to `skill_file`. Built-in rows render
**read-only** (`source = 'builtin'` makes every write API return 400 /
403); the editor's "Save" button is hidden.

### 4.2 ZIP import

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
     - track total size; bail if > 10 MB
4. Locate SKILL.md (root or single nested folder).
5. Parse + validate frontmatter.
6. Reject if name collides with an existing skill (404 / 409 path).
7. In a single transaction:
     - INSERT skill row (source='local', visibility='private', createdBy=session.user.id)
     - INSERT skill_file rows for every allowed-subdir entry
8. Return the new row's id.
```

**Lifecycle after import is identical to a `POST /api/skills` custom skill** — the row lives in the `skill` + `skill_file` tables, the user sees it in `/skills` list, can edit it, and can `DELETE /api/skills/:id` exactly like any other `source='local'` skill. The `invalidateForSkillChange(skillId)` hook fires the same way. Nothing about import creates a "transient" skill.

What's "in-memory only" is the **ZIP processing pipeline**, not the resulting skill: the upload is parsed entirely as Buffers + strings without ever writing temp files to the host filesystem. This is a security property (zero attack surface for path traversal — there is no fs target to traverse to), not a persistence claim. Memory bounds: `Content-Length` ≤ 10 MB hard cap on the upload, plus per-entry uncompressed size accounting during decode to defeat zip-bomb amplification.

The `.skill` format is the same ZIP layout DeerFlow uses, so packs
created elsewhere can be imported directly.

### 4.3 Custom-skill ID stability

Custom skills get a fresh UUID at create time. Renames are **not
supported** via PATCH (would require updating frontmatter `name:` and
all incoming `builtin_agent_tool.skill_name` resolutions). To rename:
delete + recreate.

---

## 5. RBAC integration

The full rules live in `docs/rbac.md` §2.2. For skills specifically:

```
canViewSkill = visibility=='public' OR createdBy==self OR isAdmin
canEdit      = source!='builtin' AND isEditorOrAdmin AND
               (visibility=='public' OR createdBy==self)
canDelete    = source!='builtin' AND (createdBy==self OR isAdmin)
canChange    = canDelete   // visibility / enabled gate
```

**Built-in is the absolute write barrier**. No role can mutate a
`source='builtin'` row through the API.

`updatedBy` is set automatically on every PATCH. Listing uses
`visibilitySql()` from `lib/auth/permissions.ts`.

---

## 6. Runtime caches

Two caches participate in the skills hot path:

| Pool | Keyed by | Module | Purpose |
|---|---|---|---|
| `agentPool` | agentId | `lib/agent/agent-pool.ts` | Per-agent decoded `AgentSpec`, includes `[skillId, ...]` references |
| `skillPool` | skillId | `lib/skills/skill-pool.ts` | Per-skill `SkillSpec` (skillMd + parsed frontmatter + metadata) |

Both are LRU + 10-min TTL. After every skill mutation
(`POST` / `PATCH` / `DELETE` / boot reconcile / ZIP import), the
write path calls `invalidateForSkillChange(skillId)` which:

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

---

## 8. Implementation details and quirks

### 8.1 Why `bytea` for content

Postgres TOAST handles values up to ~1 GB and auto-LZ4-compresses them
above ~2 KB. With a 256 KB hard cap and ~50–100 skills × ≤ 100 files
each, even a worst-case dataset is tens of MB — trivial. Blob storage
in PG is not the anti-pattern it's reputed to be at this scale.

### 8.2 Skill identity

Skills are identified by `(id)` (URL-stable) or `(source, name)` (the
uniqueness key boot reconcile uses to find existing built-in rows).
There is no filesystem locator on the row.

### 8.3 Why preserve disabled built-ins instead of deleting

A built-in removed in a redeploy may still be referenced by user
`builtin_agent_tool` rows. Hard delete with FK SET NULL would silently
break those agent configs. Soft-disable (`enabled=false`) keeps the
configuration visible: the admin sees "disabled built-in", chooses to
unbind or replace, then can manually delete if desired.

### 8.4 ZIP import isn't path traversal

`skill_file.path` is a **string column**, not a filesystem path. A
hostile ZIP entry named `../../etc/passwd` would simply fail the regex
validation; it cannot reach the host filesystem because no extraction
to disk ever happens. `.skill` packs are *processed* entirely in
memory and *persisted* into `skill` + `skill_file` rows like any
other custom skill — no fs side effect at any stage.

### 8.5 Caching `get_skill_file` is unnecessary

A single `SELECT content FROM skill_file WHERE skill_id = ? AND path = ?`
on a 4-byte-keyed unique index is sub-millisecond on a warm
connection. Cache hit ratio for helper files is intrinsically low
(model loads them on demand, then doesn't revisit). Adding an LRU
here would optimize ~5% of calls at the cost of cache-coherence
bookkeeping.

### 8.6 Reconcile is not a hot path

`seedBuiltinSkills` runs **once per Node process**. Even with 100
built-in skills × 50 files each, the worst-case warm-start cost is
~100 SELECT existence checks (most return checksum-match → skip). On
a cold start (new DB), it's ~5 000 INSERTs in one transaction —
seconds, not minutes.

---

## 9. Future work

- **Renaming via PATCH** — currently rejected by the API; would need to
  rewrite `builtin_agent_tool` references and frontmatter `name:` in
  one transaction. Workaround today is delete + recreate.
- **Languages beyond .py / .sh** — V1 dispatch table covers python3
  and bash only; adding e.g. `.js` / `.ts` requires a row in
  `INTERPRETER_BY_EXTENSION` AND the binary present in the sandbox
  rootfs. Out of scope until a real use case lands.

### 9.x Skill-declared Python dependencies

**Status:** Built-in skills only. User skills inherit the image's dependencies.

#### Author quick reference

Declare dependencies in `SKILL.md` frontmatter:
```yaml
---
name: my-skill
description: ...
dependencies-python: ["scikit-learn>=1.3", "scipy"]
---
```

**Commands:**
- `pnpm sandbox:build`: Regenerate `docker/sandbox/requirements.txt` and rebuild image.
- `pnpm sandbox:check`: CI drift check.
- `pnpm sandbox:deps`: Just regenerate `requirements.txt`.

The build pipeline aggregates `dependencies-python` from all built-in `SKILL.md` files, merges them with core packages, detects version conflicts (hard-failing the build), and writes a unified `requirements.txt`.

#### Future ecosystems
The flat-key naming (`dependencies-python`) leaves room for future extensions like `dependencies-node` or `dependencies-system`.
