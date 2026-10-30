# Knowledge Base

> Audience: engineers working on the KB subsystem — authoring API, agent runtime, or editor UI.
> See also: `docs/architecture.md`, `docs/skills.md`, `docs/data-sources.md`, `docs/prompts.md`, `docs/rbac.md`, `docs/config.md`, `docs/host-files.md`.

The KB is an **LLM-wiki**: knowledge is written once by humans, condensed once, and
read many times by agents. Two tables (`kb_collection` → `kb_page`) plus one junction
column. A folder is an implicit `/`-separated prefix of a page path — there is no
folder row, exactly as `skill_file` does it. Retrieval is **navigation** — an agent
walks a derived index the same way a human does.

There is no vector store, no embedding model, no tokenizer extension, no sidecar
service, no search tool, no cache, and no agent write path.

Separate concern: an **external RAG** service (e.g. RagFlow) is wrapped as an MCP
server and holds no state in Nango. It is unrelated to this subsystem.

---

## 1. Scope

| In scope | Out of scope |
|---|---|
| Human-authored, agent-read text corpus in Postgres | Binary assets, file upload, in-app PDF ingest |
| Structural (name + path outline + count) disclosure, level by level | Semantic search (`kb_search`, tsvector, pgvector) |
| Read-only tools auto-mounted by a collection binding | `kb_write` — agents never write knowledge |
| Hard deletes with cascade | Soft delete / tombstones, versioning, history |
| One long-lived Node process | Multi-replica or serverless deployment (`docs/architecture.md` §"Runtime boundary") |

## 2. The model: three disclosure levels, one page table

What is stored and how deep an agent navigates are deliberately separate. Storage
has two levels; disclosure has three.

| Disclosure level | What an agent sees | Source |
|---|---|---|
| 1. Collection | `name` + `description` | `kb_collection`, injected verbatim into the system prompt |
| 2. Folder outline | each implied folder prefix + **the count of pages sitting directly in it** | derived from `kb_page.path`, in the same injected block |
| 3. Page | path + `description`, then the content itself | `list_kb_pages`, then `read_kb_page` |

There is no fourth level. The document a page was distilled from is not in the
system; `kb_page.source_ref` is a free-form human note (§10).

The **collection is the only mountable unit** — "what does this agent know" stays
auditable from one list.

Role of each level:

- **Collection** — a coherent body of knowledge with one identity
  (`visionworks-pages`, `x-manual`). Its `description` is the level-1 routing
  signal: it is the only KB text present in every bound agent's resident prompt.
- **Folder** — a chapter, module or section, existing only as the leading
  segments of the paths under it. It has no row, so it has no name-unique
  constraint, no description, and no audit columns. Its *name* is the routing
  help at level 2; the prose about why pages belong together belongs in a page.
- **Page** — one unit of knowledge: Markdown, CSV, JSON, YAML, XML or plain
  text. `path` is both its address and the handle an agent passes to
  `read_kb_page`. The atom both the editor tree and the index address.

Content form follows use, and the system never inspects content to classify it:
a page-catalog CSV is stored verbatim, meeting notes are authored directly, and
a converted manual is pasted in one page per chapter or topic. That judgement
belongs to the author.

**The index is derived, never authored.** There is no `kb_index` table, column or
index page, and no folder table. The agent-facing index and the editor tree both
generate from `kb_collection.description` and the page paths under it, so adding,
deleting or renaming a page cannot leave an echo behind — and neither surface can
show a folder the other does not have.

## 3. Data model

### 3.1 Columns

`kb_collection` ([src/lib/db/schema.ts:886](file:///d:/AI/nango/src/lib/db/schema.ts#L886))

| Column | Type | Notes |
|---|---|---|
| `id` | uuid v4 | URL-exposed; FK target of `builtin_agent_tool.kb_collection_id`. |
| `name` | text NOT NULL | Globally unique LLM-facing slug — the string agents pass as `kb_name`. Pattern `/^[a-z][a-z0-9_-]{0,62}$/` (`KB_COLLECTION_NAME_RE`), enforced at the API edge. Doubles as the panel label. |
| `description` | text NULL | Level-1 routing signal. Required at the edge, ≥ `MIN_DESCRIPTION_CHARS`, ≤ `MAX_DESCRIPTION_CHARS`. |
| `enabled` | boolean NOT NULL | A disabled collection is absent from the prompt block and refused by both tools — indistinguishable from unbound. |
| `visibility` | text NOT NULL | `'private' \| 'public'`, same semantics and same `visibilitySql` as `skill`. |
| `created_by` / `updated_by` | uuid → user, SET NULL | §3.4. |
| `created_at` / `updated_at` | timestamp | `listCollections` orders newest first. |

`kb_page` ([src/lib/db/schema.ts:931](file:///d:/AI/nango/src/lib/db/schema.ts#L931))

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | Append-heavy child rows of one owner. Server-internal: every URL and every agent handle uses `path`, so this id never leaves the DB except inside a returned row (§13). |
| `collection_id` | uuid → `kb_collection`, CASCADE | Denormalised so "every page in this KB" is one index scan and so collection-wide path uniqueness is expressible — Postgres cannot span a join in a unique index. |
| `path` | text NOT NULL | Relative, `/`-separated, folder depth capped at `MAX_FOLDER_DEPTH`. Unique **collection-wide**. Matched exactly, case-sensitive — it is the `read_kb_page(page_path)` handle and the string the tree renders. Legal segments are prose: CJK, spaces and dots all fine; what is refused is ambiguity (empty segment, `.`/`..`, leading or trailing `/`) and control bytes (§5). |
| `description` | text NULL | Level-3 help, returned by `list_kb_pages` only; optional, never injected into the resident prompt. An empty string is stored as NULL. |
| `content` | text NOT NULL | The knowledge. Written verbatim: the edge refuses an empty body but never trims — a CSV or YAML page whose leading bytes change is a different artifact. PG TOAST compresses. |
| `content_type` | text NOT NULL, default `text/markdown` | One of six text types (§3.2). Server-side parse hint returned to the agent; the editor has no control for it and no write path patches it. |
| `size` | integer NOT NULL | Pre-computed UTF-8 byte length of `content`, so lists and budget checks never read the body. |
| `source_ref` | text NULL | Human-only provenance — §10. |
| `created_by` / `updated_by` | uuid → user, SET NULL | |
| `created_at` / `updated_at` | timestamp | |

Both tables use the project's entity vocabulary for what an agent reads. `content`
lives in Postgres, not on a volume, for the same reasons `skill_file.content` does:
transactional with its metadata, SQL-listable, covered by `pg_dump`.

**Why a path column rather than a folder table.** `skill_file` proved the shape:
one string, tree derived. A folder table bought a per-folder `description` and a
rename that touched one row, and paid for it with a second source of truth that
could disagree with the pages it owned (an empty group, a group whose `name`
needed flattening to be readable in the block, a `SET NULL` hole after a hand-run
`DELETE`). With paths, a folder is *by construction* only what its pages make it:
no orphan, no empty bucket, nothing to keep in sync. The price is a rename that
rewrites every path under the prefix — one transaction over a set already bounded
by `kb.max_pages` (§5).

Binding ([src/lib/db/schema.ts:1147](file:///d:/AI/nango/src/lib/db/schema.ts#L1147))

The existing junction `builtin_agent_tool` gains one discriminator value and its
column:

```
toolType = "knowledge"  →  kbCollectionId (uuid → kb_collection, ON DELETE CASCADE)
index builtin_agent_tool_kb_collection_idx   // reverse lookup: which agents bind this KB
```

`AgentToolType` includes `"knowledge"`; `AgentToolRef` has the variant
`{ kind: "knowledge"; kbCollectionId: string }`
([src/lib/builtin-agents/agent-spec.ts:21](file:///d:/AI/nango/src/lib/builtin-agents/agent-spec.ts#L21));
both built-in-agent routes list `"knowledge"` in their `boundToolSchema` enums and
insert the column. Deleting a collection releases its bindings.

### 3.2 Indexes and constraints

- `unique (kb_collection.name)`
- `unique (kb_page.collection_id, path)` — its leading column also serves "every
  page in this KB", so there is no separate collection index.
- `CHECK (content_type IN (…six text types…))`

### 3.3 Where each rule is enforced

A DB CHECK fires on every write path — API, service, hand-run SQL, future script.
A service check only covers paths that go through the service. A CHECK can only
see one row.

| Rule | Home | Why |
|---|---|
| `content_type` in the six-value set | DB CHECK | A `application/pdf` row slipping in makes every later reader assume UTF-8 and return mojibake. The value set is spelled identically to the text subset of `CONTENT_TYPES` in `src/lib/folder-import/mime.ts` so an import can map a file onto it without guessing. |
| `path` uniqueness | Unique index | Also mapped to `409 PATH_TAKEN` (§5). |
| `path` legality (segments, control bytes, length, depth) | Service + API edge, both through `src/lib/kb/paths.ts` | Cross-row reasoning for depth, and a page name is prose so there is no character class a CHECK could match. The edge reuses the same predicates for a typed 400; the service catches hand-run SQL and future scripts. |
| A folder and a page cannot share one name | Service | Needs the whole path set: `a` is illegal when `a/b` or `a` already exists. |
| `kb.max_pages` / `kb.max_folders` / `kb.page_max_bytes` | Service | Config-backed budgets, and the refusal must quote the measured value and the limit. |
| `content` is storable text — no NUL, no unpaired surrogate | Service | Postgres fails the row with `22021`, which would surface as an opaque 500. |
| Slug pattern, description floor and ceiling, `content` non-empty, unknown body keys refused | API edge (Zod `.strict()`) | Typed `400 VALIDATION_FAILED` with the offending path, before any DB call. |
| Visibility / edit / ownership | `src/lib/kb/access.ts` | §13. |

**Text validation — NUL and unpaired surrogates.** `assertValidText` (§5) runs
on `content`, the collection `name`, and every `description` and rejects a NUL
(`U+0000`) or an unpaired surrogate with `400 INVALID_TEXT`, before Postgres could
fail the row with `22021` and surface an opaque 500. `source_ref` is exempt: it is
a free-form maintenance note never read by any agent path, and a malformed note
there fails with a 500 rather than a 400 — accepted, not a stored-corruption
risk, because the row is never written either way. A NUL inside a *path* is caught
earlier and differently: `pathProblem` rejects every control byte as
`INVALID_PATH` (§5).

### 3.4 Ownership columns are SET NULL

`created_by` / `updated_by` on both tables use `ON DELETE SET NULL`. A KB is a
shared asset: a hard user purge must not destroy the corpus its agents read. Two
consequences, both intended:

- `ResourceWithRBAC.createdBy` is already `string | null`
  ([src/lib/auth/permissions.ts:88](file:///d:/AI/nango/src/lib/auth/permissions.ts#L88)): an orphaned **public** row stays editable by any editor, an orphaned **private** one only by an admin.
- A **private** orphaned collection is invisible to everyone but an admin
  (`visibilitySql` compares `created_by = <uid>`, false against NULL). Content
  survives; recovery means an admin re-shares or re-owns it.

`skill`, `data_source` and `artifact` CASCADE on `created_by` because their rows are
one user's resource; the KB tables break that pattern because their rows are shared
knowledge.

## 4. Module map

| Path | Responsibility |
|---|---|
| `src/lib/db/schema.ts` | The two tables + the junction column. |
| `src/lib/kb/paths.ts` | Pure path algebra: legality (`pathProblem` / `folderProblem`), `folderOf`, `ancestorFolders`, `distinctFolders`, `topLevelFolderCount`, `isUnderFolder`, `rewriteFolderPrefix`. No `server-only` — the editor validates a path with the rules the service enforces. |
| `src/lib/kb/limits.ts` | Authored-string constants (`MAX_DESCRIPTION_CHARS`, `MIN_DESCRIPTION_CHARS`, `MAX_LABEL_CHARS`, `MAX_PATH_CHARS`, `MAX_FOLDER_DEPTH`). Client-readable. |
| `src/lib/kb/budgets.ts` | Config-backed byte/count ceilings behind `import "server-only"`. |
| `src/lib/kb/validation.ts` | Shared Zod edge schemas built on `paths.ts`. Imported by the client so it cannot be told a different limit than the server enforces. No `server-only`. |
| `src/lib/kb/access.ts` | URL id → authorised collection row; the three authoring gates, the visibility+enabled filter (`filterVisibleKbCollectionIds`, used at bind time and dispatch time). |
| `src/lib/kb/service.ts` | All structural invariants and budgets for the authoring surface; typed `ApiError`s; the single sort site for the tree. |
| `src/app/api/kb/**` | Four route handlers (§14). |
| `src/lib/kb/lookup.ts` | Agent-side reads. **Deliberately RBAC-free** — the binding is the grant (§7.3). |
| `src/lib/kb/prompt-block.server.ts` | `buildKbPromptBlock(collectionIds) → { promptBlock }`. |
| `src/lib/kb/runtime-tools.ts` | `buildListKbPagesTool` / `buildReadKbPageTool` + line windowing. |
| `src/lib/runner/dispatch/builtin.ts` | Kind branch, block call, tool construction, approval-exempt set. |
| `src/lib/agent-pipeline/risk-registry.ts` | `low` / `read` / `readOnlyHint` / `headlessAllowed` for both tools. |
| `src/lib/types/kb.ts` | Client shapes + `kbTopTally`, the one tally rule. |
| `src/components/left-panels/KbPanel.tsx`, `src/components/main-panels/KbEditor.tsx`, `src/components/main-panels/kb/*` | Editor UI (§15). |
| `src/app/(workspace)/kb/**` | Routes; `layout.tsx` guards with `requireEditor`. |

There is no cache module and no fan-in runtime wrapper beside these files: two
unconditionally mounted tools and one prompt block do not need the layer
`buildSkillsRuntime` exists to give four conditionally mounted skill tools.

## 5. Flow A — authoring a write

```
UI form → src/lib/kb/validation.ts schema (edge bounds, .strict())
        → route wrapper (withSession / withEditor)
        → access.ts gate (404 hidden, 403 not editable, 403 not owned)
        → service.ts invariants + budgets (400/409 as typed errors)
        → Drizzle insert/update .returning()
        → 201/200 JSON; UI refetches the tree
```

Service-side rules, all in `src/lib/kb/service.ts`:

- **Names.** A collection unique violation (`23505`) becomes `409 NAME_TAKEN` with
  the name; any other constraint error is rethrown untouched, so a real DB fault
  never masquerades as a collision.
- **Empty patch.** `updateCollection` / `updatePage` throw `400 No fields to
  update.` before touching the DB.
- **Partial `set`.** Each writer sends only its own fields — the pane writes
  `description` + `content`, the identity dialog writes `path` / `sourceRef` —
  so the two never step on each other.
- **Path legality first.** `assertLegalPath` / `assertLegalFolder` run before any
  query, so an illegal path never costs a read and never reaches a unique index.
  The message is the rule that fired ("Page path must not contain the segment
  \"..\".") with `reason: "INVALID_PATH"` and `maxDepth`.
- **Page create.** `loadPagePaths` reads the collection's address set once, then
  `assertNoFolderClash`, `assertPageRoom` (`kb.max_pages`) and `assertFolderBudget`
  (`kb.max_folders`) all evaluate against it; `assertContentFits` measures
  `Buffer.byteLength(content, "utf8")` against `kb.page_max_bytes` and reports
  `{reason: "PAGE_TOO_LARGE", sizeBytes, maxBytes}`; `assertValidText` refuses a
  NUL or an unpaired surrogate (`400 INVALID_TEXT`); `size` is re-measured
  whenever `content` is written and left alone otherwise; `contentType` defaults
  to `text/markdown`.
- **Page update.** `getPage` throws `404` before any mutation and gives the
  rewrite checks their baseline. `path` is one field that renames *and* moves:
  when it is unchanged the address set is not even re-read. When it changes, the
  clash and folder-budget checks run on the set minus the page's own path.
  Description, source and content-type writes each stay in their own field.
- **Page-vs-folder clash.** `assertNoFolderClash` rejects a write whose path
  equals an existing path, is a prefix of one, or has one as its prefix — 409
  `PATH_TAKEN`. The tree, the index and the URL all read `a` as either a
  directory or a document, so a collection holding both is ambiguous, not merely
  untidy. A `23505` from the unique index maps to the same envelope.
- **Folder budget.** `assertFolderBudget` counts `distinctFolders` on the
  **post-write** path set and only trips when the write *adds* a prefix, so a
  rename that frees one folder name and spends another never breaches
  `kb.max_folders`, and adding a page inside an existing folder at budget is
  allowed. The refusal quotes the configured limit and tells the author which of
  the two repairs it wants (raise the key, or join an existing folder).
- **Folder rename / move** (`renameFolder`) rewrites the `path` of every page
  under the prefix inside one `db.transaction`, after validating the whole
  rewrite plan: each produced path must be legal, none may clash with a page
  outside the folder, and the post-rewrite set must stay within
  `kb.max_folders`. It returns the number of rewritten pages. Addressing a prefix
  that holds no page is `404 Folder not found: <prefix>`. `newFolder` may nest the
  folder inside itself (`a` → `a/b`) as long as every resulting path stays inside
  `MAX_FOLDER_DEPTH`.
- **Folder delete** (`deleteFolder`) deletes every page whose path starts with
  the prefix, in one `IN` delete, and returns the count. A nested folder goes with
  its parent because it is only ever a longer prefix of those same pages. Nothing
  is left pointing at a vanished directory, because there is no directory to
  vanish.
- **Audit.** Collection and page writes stamp `updatedBy` + `updatedAt`. A folder
  write stamps the pages it rewrites; the folder itself has no row.

There is no cache invalidation step: nothing is cached (§4, §16).

## 6. Flow B — binding and mounting

Binding is saved as a `builtin_agent_tool` row (§3.1); the agent editor's
**Knowledge** tab is a picker over visible collections — disabled ones are
listed with a hint rather than hidden, because a binding that was enabled at
bind time and disabled later must stay reachable — re-enable the collection
before saving, or let the save drop it — with a
`{selected, total}` badge like the Skills and Data sources tabs.

**CONTRACT — the bind filter.** "The binding is the grant" (§7.3) only holds if
the grant's write path validates, so both built-in-agent routes pass every
`knowledge` id through `filterVisibleKbCollectionIds` before inserting the tool
rows: only ids visible to the session **and** enabled are written. The read runs
on the write transaction's connection, so the visibility check and the tool-row
insert are one atomic unit — a collection that turns private, disabled, or is
deleted mid-save cannot slip a stale grant between the read and the write. An id
that no longer resolves — deleted, hidden, or disabled — is **dropped from the
binding rather than rejected**. The picker can only render what `GET /api/kb`
returns, so a collection that turned private or disabled after it was bound
would otherwise be impossible to uncheck, and every save of that agent would
fail. Dropping is equally safe: an unbindable id is never written, so the
RBAC-free runtime never sees a grant the binder could not see. The picker's
client-side list is still not a check — the API accepts any uuid and decides
server-side. The same predicate runs a second time at dispatch, against the
runner rather than the binder (§13.1).

At dispatch, [src/lib/runner/dispatch/builtin.ts:190](file:///d:/AI/nango/src/lib/runner/dispatch/builtin.ts#L190)
collects `tool.kind === "knowledge"` into `kbCollectionIds`, filters them through
`filterVisibleKbCollectionIds` against the runner into `runnableKbIds` (§13.1; no
runner identity fails closed), then:

1. `buildKbPromptBlock(runnableKbIds)` runs on **every** dispatch — two indexed
   queries for the whole bound set, no byte budget, no cache. The result is
   concatenated only when non-empty.
2. When `runnableKbIds.length > 0`, `buildListKbPagesTool` and
   `buildReadKbPageTool` are constructed with
   `{ agentKbCollectionIds: runnableKbIds }` and appended to the server tools.
   Both are **absent from `BUILTIN_TOOLS`**: the pair is a capability of the
   binding, not a user-tickable catalog entry — the same shape as the
   data-source and SSH auto-mounts.
3. Both tools are members of `APPROVAL_EXEMPT_TOOLS`
   ([src/lib/runner/dispatch/builtin.ts:619](file:///d:/AI/nango/src/lib/runner/dispatch/builtin.ts#L619)):
   read-only over operator-curated content, so gating them would only train users
   to click through.
4. Both are annotated `low` / `read` / `readOnlyHint: true` / `headlessAllowed: true`
   in `BUILTIN_TOOL_RISK_MAP`
   ([src/lib/agent-pipeline/risk-registry.ts:87](file:///d:/AI/nango/src/lib/agent-pipeline/risk-registry.ts#L87)).
   CONTRACT: without that entry an unannotated tool defaults to `medium` / `write`,
   which is wrong for a read and makes the tool fail `require`/`annotation`
   approval policies and headless runs.

Prompt slot: the block sits after the Calendar block and before the Chart block, at
slot 6 of the regular-agent order and slot 7 of the supervisor order
(`docs/prompts.md`).

## 7. Flow C — disclosure

### 7.1 The injected block

One render of `buildKbPromptBlock` produces
[src/lib/kb/prompt-block.server.ts:36](file:///d:/AI/nango/src/lib/kb/prompt-block.server.ts#L36):

```
## Available knowledge

When a question matches one of these knowledge bases, call `list_kb_pages(kb_name)`
to see its pages, then `read_kb_page(kb_name, page_path)` for the page you need.
Page bodies are never shown here — do not assume you know a KB's contents
from the lines below.

- **visionworks-pages**: VisionWorks is a data-analysis web application …
  - module-a-geo (3 pages)
    - module-a-geo-perf (2 pages)
  - module-a-topology (2 pages)
- **x-manual**: Installation and operations manual for product X …
  - chapter-01 (6 pages)
    - chapter-01/images (4 pages)
  - chapter-02 (9 pages)
  - (2 top-level pages)
- **team-notes**: Weekly notes from the platform team …
  - (12 top-level pages)
```

Rules of the render:

- Collections alphabetically by `name`; only `enabled` rows appear.
- One line per collection: `- **<name>**: <description>`.
- One line per **implied** folder: `- <folder> (<N> pages)`, indented two spaces
  per folder level (so a level-1 folder sits at four spaces, its child at six),
  ordered parent-before-child with siblings by `alphabeticCompare`.
- `N` counts the pages sitting **directly in that folder**, not its subtree — the
  subtree is one `list_kb_pages(kb_name, folder)` away by design. A folder that
  holds only subfolders reports `(0 pages)`, which is what makes the line read as
  structure rather than content.
- `- (<N> top-level pages)` when the collection has pages with no prefix. A flat
  collection is a legitimate shape; without this line it would render as
  description-plus-zero-bullets and read as empty. The line leads the folder
  bullets, because a trailing count directly under the deepest folder's line reads
  as that folder's child. The count is not addressable — those pages are reachable
  by `page_path` alone.
- Nothing below folder level, always, regardless of collection size: a page's
  **path is never printed here**, only the folders its path implies. The paths come
  from `list_kb_pages`.
- Folder paths are **not** flattened into handles — the block prints them with their
  separators, and `list_kb_pages(folder)` matches the same string exactly (§7.3).
- **SECURITY:** names, descriptions and folder paths are whitespace-flattened
  (`flatten()` in the same file) before rendering. This text is author-written and
  lands in the system prompt, so a newline in any of them must not mint its own
  bullet and imitate another collection. Control bytes cannot appear at all: the
  write edge refuses them in a path (§5), so a printed path is always a usable
  handle — the flattening that used to be able to break a group name can only ever
  collapse ordinary spaces here.
- `promptBlock` is `""` when no usable collection is bound, and the caller skips
  the concatenation.

### 7.2 What the block costs, and why nothing clips it

Resident size is bounded **at write time** by the structural caps: `kb.max_folders`
per collection, `MAX_DESCRIPTION_CHARS` 512, `MAX_PATH_CHARS` 256, and
`MAX_FOLDER_DEPTH` 2, which is also the cap on indentation. Worst case at the
defaults is a few KB of ASCII for one collection — CJK roughly triples it, since
caps count characters while the block counts bytes.

There is **no mount byte budget**, so nothing is silently dropped and no
residual-pointer hint is needed. Truncation is the failure mode this rules out: an
agent that sees 8 of 20 chapters answers "the KB has no chapter about Y" with full
confidence, so the choice is between an occasionally large prompt — visible, the
author's own edit to undo, and paid in tokens — and an occasionally blind agent. The
bound is a write-time one: `kb.max_folders` and the description and path caps, with
the configured number quoted in the refusal (§11). The editor shows the
collection's top-level count; it shows no mount byte size, because reading that
accurately means running the block renderer on every list request. An author who
wants a smaller mount shrinks the KB.

The same reasoning covers `list_kb_pages`, which is larger than the resident block
by design: at `kb.max_pages` the page paths plus descriptions cost ≈35 KB of ASCII
for one call. Page descriptions are the second-level routing signal — the agent
picks which of 50 pages to open from them — so clipping them trades a token bill
for a blind agent. It is one call, released back into history on the next turn, and
takes no budget key.

### 7.3 `list_kb_pages`

`src/lib/kb/lookup.ts` is the agent-side read layer: **no RBAC**, because binding
the collection is the grant. Visibility is evaluated at the two grant moments —
bind time (§6) and dispatch time (§13.1) — so the per-call read path here stays
RBAC-free, exactly as skills and data sources already work.

`listKbIndexPages(collectionId)` runs one query — the projection is exactly
`path` and `description`, so a body never leaves the DB on this path — and returns
every page of the collection ordered by path. The tool buckets it:

- without `folder`, the response holds **every** page of the collection, each with
  its full path, and no folder grouping — the agent reads the structure out of the
  paths themselves;
- with `folder`, only the pages whose path starts with `<folder>/` — **the whole
  subtree**, so a two-level tree cannot hide content behind a second call — plus
  the echoed `folder`.

Row ids stay internal: an agent addresses a page by path and a folder by prefix.

Typical reach for one question: small flat collection, block → `list_kb_pages` →
`read_kb_page` (**2 hops**); 20-chapter manual, still **2 hops** — the block already
shows the chapter prefixes, so narrowing with `folder` is optional, not required.
The resident prompt stays small because it carries counts, never titles.

### 7.4 Ordering: natural sort applied in JS on every read

Everything orders by path (collections by `name`) with `alphabeticCompare`
([src/lib/utils/sort.ts](file:///d:/AI/nango/src/lib/utils/sort.ts)) — the shared
numeric-aware comparator used by frontend lists and backend runners to prevent
ordering drift.

**CONTRACT:** Postgres sorts bytes without `COLLATE`, so `ORDER BY path` alone puts
`chapter-10/install` before `chapter-2/install`. Every KB list read applies
`alphabeticCompare` in JS after the SQL read — the same two-step the evaluation,
verification and web-auto storage layers use. That is `service.getPages` (sorted
once, so the editor tree and the agent index cannot drift),
`lookup.listEnabledKbCollectionsByIds` and `lookup.listKbIndexPages`. The derived
folder sets order the same way, in `paths.distinctFolders`; a parent still precedes
its children there because its string is a strict prefix of theirs. The failure is
silent if missed: a byte-ordered chapter list looks plausible to both agent and
author.

There is no `display_order` column: a manual ordering field is what you add after
natural sort turns out wrong for the content, and `chapter-NN` paths already order
correctly under it.

## 8. Flow D — `read_kb_page` windowing

Every format is line-windowed, because "stored verbatim" and "fits in one tool
response" are separate questions: a 200 KB CSV is legitimate final form and
illegitimate as a single context injection.

`windowByLine` in [src/lib/kb/runtime-tools.ts:251](file:///d:/AI/nango/src/lib/kb/runtime-tools.ts#L251):

- `offset` is a 1-based line index (default 1), `limit` a line count (1–5000). An
  omitted `limit` means "as many lines as fit the remaining `kb.read_max_bytes`".
- The budget always wins: a window is cut at the budget even with a large `limit`.
  A zero/negative/fractional `kb.read_max_bytes` is a mis-configuration, not a
  mode, and floors at 1 byte (like `host.file.read_max_bytes`) — an unfloored
  budget would return an empty window whose `nextOffset` equals the requested
  `offset`, and the agent would page in place forever.
- Content is normalised to LF first (`\r\n` and `\r` → `\n`) so windows are stable.
- **A line longer than the remaining room is cut mid-line**, not returned whole —
  SECURITY: the budget is what keeps one tool result from flooding the context.
  The cut is final for that line: `endLine` names the cut line and `nextOffset` is
  `endLine + 1`, so **the tail of the line is reachable by no `offset`** — a retry
  returns the same head. `truncated: true`, `nextOffset` and a `note` say so and
  point at the repair on the authoring side (re-import the page pretty-printed /
  wrapped). Known limitation: a page that is one unbroken line — minified JSON, a
  single-row CSV — is readable only up to `kb.read_max_bytes`.
- The cut drops a partial code point rather than emitting U+FFFD. Bytes, not
  characters, are counted: a CJK page's `line.length` understates its context cost
  threefold.
- `offset` past `totalLines + 1` returns an **empty window, not an error** — the
  same shape as `read_file` — so probing the tail costs nothing.
- There is no `raw`/byte-offset mode. A page that only makes sense as raw bytes
  should be re-imported formatted, not paged around.
- Envelope: `ok`, `kbName`, `pagePath`, `description`, `contentType`, `content`,
  `startLine`, `endLine`, `totalLines`, `truncated`, `nextOffset?`, `note?`.
  `source_ref` is never among them.
- A `page_path` that names a **folder** is a page miss (`NO_SUCH_PAGE`), never a
  subtree read: the prefix is not a row, and the tool that lists a prefix is
  `list_kb_pages`.

## 9. Flow E — deletion

All deletes are hard. A tombstone on these tables would have to be filtered out of
every read path including the block, and nothing here needs recoverability beyond
what `pg_dump` already gives.

| Delete | What happens |
|---|---|
| Collection | `kb_page` cascades; `builtin_agent_tool` rows release the binding; the next dispatch renders no block for it. Author or admin only (`loadOwnedCollection`). |
| Folder | `deleteFolder` deletes every page whose path carries the prefix, in one `IN` delete — a directory *is* its pages, so nothing is orphaned and no nested check exists to refuse. Returns the deleted count; a prefix with no pages under it is `404`. |
| Page | `getPage` `404` check first, then a single delete by id. |

## 10. Provenance and the miss loop

`source_ref` is a free-form maintenance note in the spirit of `skill.source` — a
label, not a locator. No FK, no validation beyond a length cap, no path resolution,
no reachability check, and **no agent tool path ever reads it**. There is no
staleness mechanism — no watcher, no re-import schedule, no stored hash. A maintainer
deciding whether a page has drifted reads `source_ref` and the source.

Because agents never fetch originals, a question no page answers has no runtime
recourse. The fix is the maintenance loop, not a mechanism: the agent says the KB
does not cover it → the run is in `entity_run`, and `/admin/run/[id]` shows the
exact failed navigation → a human adds or improves a page. Consequently **page
paths and descriptions carry the entire recall surface**: the usual diagnosis is
"the page exists but its path does not say so", and the usual repair is a rename or
a sharper `description`, not a new page. A path is also the only folder name an
agent can see, so a folder that hides its content's subject makes the whole subtree
unfindable from the block.

Getting a large document in is an authoring action: convert externally
(`pdftotext`, an exporter, or the user's own agent), then paste the result into the
editor page by page. There is no file import — a page is plain text, so a picker
would re-implement the clipboard for one step of a two-step job. An agent holding a
`read_file` binding can read an already-converted text source from the
`host.file.root` mount and the author pastes the condensed result back
(`docs/host-files.md`); it cannot read a PDF.

Agents do not write knowledge. There is no `kb_write`: index quality, budget
enforcement and the miss loop above all assume a human in the loop.

## 11. Budgets and limits

Two units, deliberately. **Authored strings are characters, fixed code constants**
— tuning them would mean re-tuning the corpus afterwards, and they bound a single
string on a resource the operator also writes. **Content and volume ceilings are
stored bytes (UTF-8) and are operator tunables** in Admin → Config under the `kb.`
prefix (`docs/config.md`), never `.env`, consistent with the `skill.*` and
`host.file.*` precedent.

| Item | Value | Home | Bounds |
|---|---|---|---|
| `MAX_DESCRIPTION_CHARS` | 512 | `src/lib/kb/limits.ts` | One `description` (collection or page). KB descriptions are the only ones in this project injected *en masse*, so they sit below the 1000-char caps used by skill frontmatter and suite descriptions. |
| `MIN_DESCRIPTION_CHARS` | 10 | same | The collection `description` only. A short-but-present one renders as a confident routing line that routes nowhere, so it is refused at the write edge (`trim()` first, then the min — whitespace-only fails). Page descriptions are optional and exempt; a folder has no description at all. |
| `MAX_LABEL_CHARS` | 200 | same | A page's free-form `source_ref`. |
| `MAX_PATH_CHARS` | 256 | same | One `path`, which is also the agent's handle. Deliberately the same ceiling the folder-import transport puts on a manifest path (`IMPORT_PATH_MAX_CHARS`), so a corpus imported from a folder can never overflow the storage rule it lands in. |
| `MAX_FOLDER_DEPTH` | 2 | same | Folder levels below a collection, so a page path is at most three segments. Stated in the runtime index, the tree UI and the service's path checks. Client-readable, unlike the budgets. |
| `kb.page_max_bytes` | 262144 | `src/lib/kb/budgets.ts` + config | One page's stored `content`. |
| `kb.read_max_bytes` | 65536 | same | One `read_kb_page` response — a context-flooding guard, not a write limit; floors at 1 byte (§8); the stored-vs-returned pair mirrors `host.file.write_max_bytes` / `read_max_bytes`. |
| `kb.max_pages` | 50 | same | Pages per collection. Also the bound on a folder rewrite's blast radius (§5). |
| `kb.max_folders` | 20 | same | Distinct prefixes the pages imply, and therefore the ceiling on injected index lines. |

Not configurable: folder depth, text-only `content_type`, collection-level
mount granularity. All values assume a personal / small-team corpus on one Node
process, matching the project's runtime boundary.

## 12. Tool surface

| Tool | Arguments | Success envelope |
|---|---|---|
| `list_kb_pages` | `kb_name` (required, 1–63), `folder` (optional, exact prefix, ≤ `MAX_PATH_CHARS`) | `{ ok, kbName, description, pages[{path, description}], folder? }` |
| `read_kb_page` | `kb_name`, `page_path` (required, exact), `offset?`, `limit?` | `{ ok, kbName, pagePath, description, contentType, content, startLine, endLine, totalLines, truncated, nextOffset?, note? }` |

Argument spelling follows the house split: multi-word tool **arguments** are
snake_case (`data_source_name`, `calendar_name`, `target_path`), **response fields**
are camelCase like `read_file`'s `startLine` / `sizeBytes`. `kb_name` / `page_path`
are spelled out because `collection` next to `page` reads as ambiguous. The stored
entity stays `kb_collection`; only the tool surface says `kb`.

**CONTRACT — failure envelopes.** Exactly three codes, and each names the reason
and nothing else:

| Code | When |
|---|---|
| `KB_NOT_AVAILABLE` | Unknown slug, collection bound to a different agent, or disabled — deliberately one indistinguishable answer, because distinguishing them would let a tool call enumerate which KBs a deployment has. |
| `NO_SUCH_PAGE` | `page_path` is not a page of that collection — including when it names a folder. |
| `FOLDER_NOT_FOUND` | `folder` is not a prefix of any path in that collection. |

No failure returns the list of valid names. `list_kb_pages` is the discovery tool
and `## Available knowledge` is the discovery channel; an error path is not one, and
an `available` array would duplicate the tool, cost 50 paths × 256 characters on the
one path nobody asked to read, and arrive as a side effect of a mistake.
Failures also short-circuit reads: `resolveKbCollectionForAgent` runs before the
index or page query, and returns `null` without querying for an empty binding set.

Risk classification: `low` / `sideEffects: "read"` / `readOnlyHint` /
`headlessAllowed`, and both are approval-exempt (§6).

## 13. Access model

Page guard: `src/app/(workspace)/kb/layout.tsx` → `requireEditor`. Sidebar entry
`kb` ("Knowledge") is `requiredRole: "editor"`
([src/components/layout/sidebar-panel-registry.tsx:122](file:///d:/AI/nango/src/components/layout/sidebar-panel-registry.tsx#L122)).

| Gate | Home | Failure | Used by |
|---|---|---|---|
| Visible (own, public, or admin) | `loadVisibleCollection` | `404 NOT_FOUND` — hidden and missing are identical, so private ids stay opaque | `GET /api/kb/[id]`, `GET …/pages/[...path]` |
| Content write | `loadEditableCollection` | `403 FORBIDDEN` | all POST/PATCH/DELETE routes |
| Strict ownership — `enabled`, `visibility`, collection delete | `loadOwnedCollection`, plus `canChangeVisibility` for the two fields | `403 FORBIDDEN` | `DELETE /api/kb/[id]`; the two fields inside `PATCH /api/kb/[id]` |
| Bindable — visible **and** enabled | `filterVisibleKbCollectionIds` | Ids that fail are silently dropped from the save; the rest are bound | `POST /api/builtin-agents`, `PATCH /api/builtin-agents/[id]` when tools are replaced (§6) |
| Runnable — visible **and** enabled | `filterVisibleKbCollectionIds` | Ids that fail are dropped from the block and tools at dispatch; no runner identity fails closed | `src/lib/runner/dispatch/builtin.ts` (§13.1) |
| Malformed uuid segment | `UUID_RE` pre-check | `404` before any query — a non-uuid can never match the column and Postgres would surface it as a 500 | all `[id]` routes |
| Empty page path in the URL | route-level check on the rejoined catch-all | `400` "Missing page path." / "Missing page or folder path." | `…/pages/[...path]` |

**Addressing.** A page URL is `/api/kb/<collectionId>/pages/<segments>`; the
catch-all arrives already decoded and the route rejoins the segments with `/`, so
one URL maps to exactly one stored path and the stored path is the handle the agent
uses. There is no bigint row id in any KB URL, so no `parseRowId` / `requireRowId`
helper exists: the collection id gates the row, the path names it.

A public collection another editor authored can be read and improved but **not
unmounted or made private** — that asymmetry is the whole reason the strict gate is
separate from the edit gate.

Hidden ≡ missing holds for the **read** gate only. The write gates load the row by
id before checking the right, so a private collection id the session cannot see
answers `403`, while an unknown id answers `404`. Skills instead runs its
visibility check first on every method and hides both behind `404`; the KB
divergence is deliberate — on a write route the caller already names the row it
means to change.

Runtime reads stay RBAC-free by design (§7.3):
`resolveKbCollectionForAgent(name, allowedIds)` checks only that the id is in the
agent's own bound set and the row is `enabled`. Visibility is re-evaluated
**once per dispatch** against the runner — not per tool call — see §13.1.

### 13.1 Visibility is re-checked once, at dispatch

The binding is the grant, but a grant must not outlive the audience the binder
could see. The built-in dispatch re-evaluates visibility **once, at dispatch
time, against the runner**: after collecting the agent's bound `knowledge` ids,
`buildBuiltinAgents` passes them through `filterVisibleKbCollectionIds` (the same
visible-and-enabled predicate the bind filter uses, §6) with the runner's
`{userId, isAdmin, isEditor}`. Only the surviving ids are handed to
`buildKbPromptBlock` and the two tools, so a **public agent run by another user**
mounts no block and no tools for a **private collection bound by its author** —
the cross-user disclosure the bind-time-only check allowed. A programmatic
dispatch with no runner identity fails closed and mounts nothing.

Two flips previously reached the leaky state; both are settled now:

- the collection turns from public to private after it was bound;
- the agent turns from private to public after a private collection was bound.

Neither flip touches `builtin_agent_tool`, but the dispatch filter drops the
collection from the running user's view regardless. The grant row itself is
unchanged, so the revocation points remain the owner unbinding in an editor
save, an editor save that cannot see the collection (the bind filter drops it,
§6), or deleting / disabling the collection. The binder's own runs still see the
collection, because the runner is the binder and `visibilitySql` admits the
owner.

Residual, deliberate: visibility is a **per-run snapshot**. A flip that happens
mid-run is not re-checked on later tool calls — `resolveKbCollectionForAgent`
still checks only `enabled` + membership — so an in-flight run keeps reading a
collection made private after it started. That window is a single run's
lifetime; closing it would mean per-call RBAC in the read path, which is
rejected for the same reason as before.

## 14. API surface

| Method + path | Wrapper | Behavior |
|---|---|---|
| `GET /api/kb` | `withSession` | Visible collections, newest first, each with `folderCount` (level-1 only) and `pageCount` — one collection query plus one path read for the whole set, tallies derived in JS. |
| `POST /api/kb` | `withEditor` | `{name, description, visibility?}` `.strict()` → `201`. Private by default; `createdBy`/`updatedBy` from the session. |
| `GET /api/kb/[id]` | `withSession` | Collection row + every `pages` summary in agent order, no page bodies and no folder payload — the editor derives its tree from these paths. |
| `PATCH /api/kb/[id]` | `withEditor` | Two gates: content (including the slug) under the edit gate; `enabled`/`visibility` under `canChangeVisibility`. `400` on an empty patch. |
| `DELETE /api/kb/[id]` | `withEditor` | Strict gate → `204`. Hard delete with cascade. |
| `POST /api/kb/[id]/pages` | `withEditor` | `{path, description?, content, contentType?, sourceRef?}`; `content` `min(1)` and untrimmed → `201` with computed `size`. The path carries its folder prefixes; the folders exist as long as this row does. |
| `GET /api/kb/[id]/pages/[...path]` | `withSession` | The only human-facing read that returns `content`. |
| `PATCH /api/kb/[id]/pages/[...path]` | `withEditor` | Page: partial update, `newPath` renames and moves through one field; re-measures `size` only when `content` is written. |
| `DELETE /api/kb/[id]/pages/[...path]` | `withEditor` | `204`. |
| `PATCH /api/kb/[id]/pages/[...path]?kind=folder` | `withEditor` | `{newPath}` → `{ ok: true, rewritten }` — the count of page paths rewritten under the prefix. A move is the same write. |
| `DELETE /api/kb/[id]/pages/[...path]?kind=folder` | `withEditor` | `204`, deleting the prefix's whole subtree. |

The catch-all segments are rejoined with `/`, so `…/pages/chapter-01/images/build`
addresses the page `chapter-01/images/build`. `?kind=folder` is the only switch:
the scope of the write differs, the address shape does not. The client builds those
segments with `encodePathSegments` from `src/lib/paths.ts`.

`parseBody` renders Zod failures as the standard `400 VALIDATION_FAILED` envelope
with the offending path; `ApiError` throws render the standard error envelope.

## 15. Editor UI

The KB registers a left-panel entry in the existing workspace shell (already a
resizable left-list / center-editor / right-chat group) and owns the center pane —
it does not build a third three-panel layout. Rows, header strips and dialogs reuse
the Skills page's class strings.

| Pane | Contents |
|---|---|
| `KbPanel` | One row per collection: the slug, a muted `(N)` **outside** the name button so it survives a truncated name, the description at `line-clamp-2`, then pencil (metadata), visibility, enabled — in that order. `N` comes from `kbTopTally` (see below). Create and collection-metadata live in one dialog here; there is no `/kb/new` route and no collection row inside the editor. No mount byte size, no reverse lookup of binding agents, no delete in the row. |
| `KbEditor` | The header strip: back arrow, the collection's `name` and its `(<tally>)`, then **Save** (`canEdit`, disabled until the pane is submittable — dirty for an existing page, body filled for a new one) and **Delete** — the collection's own delete is the header's only destructive action, because node deletes belong to the rows they name. Below it, two fixed flex columns: the `w-80` tree and the detail pane, with no drag handle between them. |
| `KbTree` | Its own `Pages (pageCount)` header carries the one create action (**New page**), absent rather than disabled for a viewer who cannot edit. **There is no "New folder" button**: a folder exists as soon as a page path names it, so the page dialog's path field is the only way to make one — and a folder cannot be created empty. Subdirectories render before files at every level, the root pages as bare rows at the tail with no heading (a heading would be a folder the server refuses). A folder row is a disclosure control only: its chevron folds the subtree and touches nothing in the detail pane, because a folder has no body; its `(N)` is the **subtree** count, so folding never hides a number the author is scanning for. Only a page row selects. Folds are held in a client *collapsed* set so a write that reloads the tree cannot undo what the author just folded; the set is keyed by prefix because a folder has no id. Tree starts expanded. Every row surfaces pencil + trash on hover; the trash describes **the row it sits on**. |
| `KbFolderDialog` | Rename a folder, which is the same write as moving it: one path field, prefilled with the prefix, and a line stating how many pages it rewrites. Nothing to describe and nothing to create — a folder has no description and no row, so the dialog owns exactly the new spelling. Writes by itself (`?kind=folder`), renders the refusal inline, signals the editor to refetch. |
| `KbPageDialog` | A page's identity only — **path** and **source**. One field says where a page lives, because a path is both its name and its folder: typing `onboarding/glossary` creates that folder for as long as the page keeps it. The help line echoes the derived folder (`in onboarding`, or `in the collection root`) and an in-collection collision is said here, not by a 409. In create mode it hands the answers to the pane instead of posting (`POST` refuses empty `content`, and an agent-visible empty page is worse than an extra click); in edit mode it sends the `PATCH` of its two fields — an unchanged path is not sent at all — and renders the refusal inline. |
| Detail pane | The selected page's `description` + body, nothing else — path and source are the dialog's, `content_type` has no control. Saved by the header **Save**. Opens with nothing selected and one line of prompt, because neither the collection nor a folder has a form here. |

Cross-cutting UI rules:

- **One tally rule.** `kbTopTally` in [src/lib/types/kb.ts:37](file:///d:/AI/nango/src/lib/types/kb.ts#L37):
  level-1 folders when the collection has any, otherwise its pages — a flat
  collection is not empty and a `(0)` would say otherwise. The panel's number is
  server-computed (`GET /api/kb` derives `folderCount` from the level-1 segments of
  the path read, so the two agree); the editor header derives its own from the
  page array the tree route already returned, through the same
  `topLevelFolderCount` helper, which keeps it exact after every write at no second
  query.
- **A pending create is visible.** A page whose path the dialog confirmed but
  whose body is unposted renders as a draft row in the folder its path names —
  selected, marked dirty, action-less, the only row without a database row behind
  it. That draft row is also how a *new folder* appears in the tree before it holds
  anything real. It becomes a real row on the `POST`, and Save keeps the label
  "Save" in both states. A draft aimed at a folder that is then deleted loses its
  home and is dropped.
- **Page bodies are plain textareas.** No Markdown preview, no rendered view, no
  format picker, no in-app table or tree editor: these pages are what an agent
  reads, `content_type` is only a parse hint the server defaults, and a CSV or JSON
  page is an exported artifact of another system whose quoting and delimiter
  invariants freeform editing breaks — you change one by replacing the whole body.
- **Description floors are shown, not spent.** The form that writes a collection
  description carries a counter that turns destructive under
  `MIN_DESCRIPTION_CHARS` and disables submit. Page descriptions are optional and
  capped only, so `maxLength` enforces their bound and the pane prints no counter.
- Renaming is the dangerous corner: `kb_collection.name` and a page's `path` are
  strings agents already hold mid-conversation. The write edge enforces the slug
  rule, the dialogs state the failure, and nothing broadcasts a rename. A folder
  rename is the widest one of all — it rewrites every path under the prefix — so
  the dialog prints the blast radius before it submits. An open editor keeps
  showing the old collection name in its header until its next write refreshes the
  tree.
- **Selects need `label`.** Base UI `Select` renders the closed state from each
  option's `label`, not its children, so an item written with only children shows
  the raw id the moment it is chosen.
- **Permission gating** uses the shared `useResourcePermissions` hook; a denied
  action renders a static `<span>` where the button was, or nothing where the action
  has no read-only meaning — never a disabled button. The panel gates the toggles on
  `canChangeVisibility` and the pencil on `canEdit`. In the editor `canEdit` decides
  nothing beyond `readOnly` and which controls appear, because any collection that
  loads already passed `loadVisibleCollection`; it is the single `editable` flag the
  tree reads, and it removes the create action and every row's pencil and trash
  together. `canDelete` alone gates the header Delete. The hook settles a beat after
  mount so the action cluster appears rather than flashing "Read-only" at an author.
- The center pane is **not** wired to `useCopilotDraft`: that mechanism exists so an
  agent can rewrite a resource, and agents cannot write knowledge.

## 16. Tests

| File | Covers |
|---|---|
| `tests/unit/lib/kb/paths.test.ts` | The pure algebra, off the DB: legal prose paths (CJK, spaces, dots), every ambiguous form refused with its own message, control bytes, the `MAX_PATH_CHARS` boundary, the depth cap counted in folder levels, `folderOf` / `ancestorFolders` / `distinctFolders` (parent-before-child, pages never imply themselves) / `topLevelFolderCount`, `isUnderFolder` prefix boundaries and the never-claims-root rule, `rewriteFolderPrefix` including lift-to-root. |
| `tests/unit/lib/kb/service.test.ts` | Write edges and budgets: one combined path read for the list tallies, natural sort, `404` guards that fire before a mutation, private-by-default and audit stamps, empty-patch `400` before any query, `NAME_TAKEN` only for `23505` (other errors rethrown untouched), illegal path before any select, page-inside-page and name-over-folder clashes as `PATH_TAKEN` (plus the `23505` mapping), `INVALID_TEXT` (NUL/unpaired surrogate in content, path and descriptions; `source_ref` exempt), `kb.max_pages` and `kb.max_folders` refusals with the budget evaluated on the post-rewrite set, byte-`size` re-measure, CJK `PAGE_TOO_LARGE`, `newPath` rename-and-move, folder rename rewriting exactly the subtree paths in one transaction, folder delete taking nested folders, `404` for a prefix that holds nothing. |
| `tests/unit/lib/kb/lookup.test.ts` | No query for an empty id set; natural order of mounted collections; unbound vs. disabled indistinguishable; the index and page reads project exactly what the agent may see (index omits `content`, page read omits `sourceRef`); one path read for the whole bound set. |
| `tests/unit/lib/kb/runtime-tools.test.ts` | Whole-collection vs. `folder` subtree views; the subtree includes nested prefixes and an exact-miss prefix does not; case-sensitive misses; the three envelopes with no discovery payload; a folder prefix asked of `read_kb_page` is a page miss; line windowing under a byte budget, `nextOffset` continuation, mid-line cut + `note`; LF normalisation; partial code point dropped; `limit` vs. budget precedence; out-of-range offset → empty window; reads short-circuited when resolution fails. |
| `tests/unit/lib/kb/prompt-block.test.ts` | Empty/disabled bindings render `""` with no reads; two queries per dispatch regardless of count; the top-level count line leads the folder bullets; indentation per folder level; direct-page counts only, `(0 pages)` for a folder of folders; leaf paths never printed; counts scoped per collection; legacy NULL description; whitespace flattening cannot mint a bullet; no trailing newline. |
| `tests/unit/app/api/kb-routes.test.ts` | All four real route handlers end to end: role gates (`401`/`403`), malformed ids, slug and description refusals, `.strict()` unknown keys, two-gate PATCH, `204`/`409` deletes, the pages-only tree projection, path-addressed GET/PATCH/DELETE through the catch-all, `newPath` moves, `?kind=folder` rename (`{ ok, rewritten }`) and subtree delete, empty-scope `400`s, depth and ceiling refusals, verbatim `content` and computed `size`. |
| `tests/unit/app/api/builtin-agents-route.test.ts`, `builtin-agent-id-route.test.ts` | The bind filter on create and on tool replacement: a deleted, hidden or disabled id is dropped while the save still succeeds; bindable ids in the same save survive; non-knowledge bindings are never dropped. |
| `tests/unit/lib/runner/dispatch-builtin.test.ts` | Binding mounts both tools with the agent's id set and injects the block; unbound renders nothing and builds nothing; slot order Calendars → knowledge → Charts; dispatch-time visibility filter drops a bound collection the runner cannot see and fails closed without a runner ctx. |
| `tests/unit/lib/agent-pipeline/risk-registry.test.ts` | Both tools evaluate `low` / `read` / no approval / headless-allowed. |

```bash
pnpm test -- tests/unit/lib/kb tests/unit/app/api/kb-routes.test.ts \
  tests/unit/app/api/builtin-agents-route.test.ts tests/unit/app/api/builtin-agent-id-route.test.ts \
  tests/unit/lib/runner/dispatch-builtin.test.ts
pnpm check-types && pnpm lint && pnpm comments:check:all
```

Schema changes go through `pnpm db:generate --name=<name>` and commit both the SQL
and the `meta/` snapshot (AGENTS.md rule 7). A change that breaks stored data
compatibility drops and recreates the table instead of migrating it — see the
disposable-data rule in `docs/architecture.md`.
