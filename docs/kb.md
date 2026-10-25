# Knowledge Base

> Audience: engineers working on the KB subsystem — authoring API, agent runtime, or editor UI.
> See also: `docs/architecture.md`, `docs/skills.md`, `docs/data-sources.md`, `docs/prompts.md`, `docs/rbac.md`, `docs/config.md`, `docs/host-files.md`.

The KB is an **LLM-wiki**: knowledge is written once by humans, condensed once, and
read many times by agents. Three tables (`kb_collection` → `kb_group` → `kb_page`)
plus one junction column. Retrieval is **navigation** — an agent walks a derived
index the same way a human does.

There is no vector store, no embedding model, no tokenizer extension, no sidecar
service, no search tool, no cache, and no agent write path.

Separate concern: an **external RAG** service (e.g. RagFlow) is wrapped as an MCP
server and holds no state in Nango. It is unrelated to this subsystem.

---

## 1. Scope

| In scope | Out of scope |
|---|---|
| Human-authored, agent-read text corpus in Postgres | Binary assets, file upload, in-app PDF ingest |
| Structural (name + description + count) disclosure, level by level | Semantic search (`kb_search`, tsvector, pgvector) |
| Read-only tools auto-mounted by a collection binding | `kb_write` — agents never write knowledge |
| Hard deletes with cascade | Soft delete / tombstones, versioning, history |
| One long-lived Node process | Multi-replica or serverless deployment (`docs/architecture.md` §"Runtime boundary") |

## 2. The model: three disclosure levels, two storage levels

What is stored and how deep an agent navigates are deliberately separate.

| Disclosure level | What an agent sees | Source |
|---|---|---|
| 1. Collection | `name` + `description` | `kb_collection`, injected verbatim into the system prompt |
| 2. Group | group name + description + **page count** | `kb_group` + a count over `kb_page` |
| 3. Page | the content itself | `kb_page.content`, only via `read_kb_page` |

There is no fourth level. The document a page was distilled from is not in the
system; `kb_page.source_ref` is a free-form human note (§10).

The **collection is the only mountable unit** — "what does this agent know" stays
auditable from one list.

Role of each level:

- **Collection** — a coherent body of knowledge with one identity
  (`visionworks-pages`, `x-manual`). Its `description` is the level-1 routing
  signal: it is the only KB text present in every bound agent's resident prompt.
- **Group** — a chapter, module or section. Exists so a large collection is
  navigable without putting page names into a resident prompt.
- **Page** — one unit of knowledge: Markdown, CSV, JSON, YAML, XML or plain
  text. The atom both the editor tree and `read_kb_page` address.

Content form follows use, and the system never inspects content to classify it:
a page-catalog CSV is stored verbatim, meeting notes are authored directly, and
a converted manual is pasted in one page per chapter or topic. That judgement
belongs to the author.

**The index is derived, never authored.** There is no `kb_index` table, column or
index page. The agent-facing index and the editor tree both generate from
`kb_collection.description`, the `kb_group` rows, and the page rows under them, so
adding, deleting or renaming a page cannot leave an echo behind.

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

`kb_group` ([src/lib/db/schema.ts:928](file:///d:/AI/nango/src/lib/db/schema.ts#L928))

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | Server-internal; never in a URL except as a row id in a nested path. |
| `collection_id` | uuid → `kb_collection`, CASCADE | |
| `parent_id` | bigint → `kb_group`, RESTRICT, NULL | NULL = level-1 group. Depth capped at 2 levels by the service (§5). |
| `name` | text NOT NULL | Unique within the collection. Rendered in the block **and** matched exactly as `list_kb_pages(group_name)`, so a rename invalidates names an in-flight agent already read. No slug form — prose, case-sensitive. |
| `description` | text NULL | Required at the edge, ≥ 10 chars. CONTRACT: prose about why the pages belong together — never an enumeration of them, which would recreate the drift §2 removes. Enforced as an editor hint and this rule, not by the server. |

A group table rather than `skill_file`-style path prefixes: a rename is one row
update with no descendant rewrite, and a group carries a `description` a path
prefix cannot. `kb_group` has no audit columns, so a group write carries no actor.

`kb_page` ([src/lib/db/schema.ts:975](file:///d:/AI/nango/src/lib/db/schema.ts#L975))

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | Append-heavy child rows of one owner. |
| `collection_id` | uuid → `kb_collection`, CASCADE | Denormalised so "every page in this KB" is one index scan and so collection-wide name uniqueness is expressible. |
| `group_id` | bigint → `kb_group`, SET NULL, NULL | NULL = the page sits at the collection root. The DB keeps the conservative behaviour for a hand-run `DELETE`; the service deletes a group's pages with it (§9). |
| `name` | text NOT NULL | Unique **collection-wide, across all groups** — it is the `read_kb_page(page_name)` handle, so an agent opens a page without knowing where it sits. Matched exactly, case-sensitive. |
| `description` | text NULL | Level-2 help, returned by `list_kb_pages` only; optional, never injected into the resident prompt. An empty string is stored as NULL. |
| `content` | text NOT NULL | The knowledge. Written verbatim: the edge refuses an empty body but never trims — a CSV or YAML page whose leading bytes change is a different artifact. PG TOAST compresses. |
| `content_type` | text NOT NULL, default `text/markdown` | One of six text types (§3.2). Server-side parse hint returned to the agent; the editor has no control for it and no write path patches it. |
| `size` | integer NOT NULL | Pre-computed UTF-8 byte length of `content`, so lists and budget checks never read the body. |
| `source_ref` | text NULL | Human-only provenance — §10. |
| `created_by` / `updated_by` | uuid → user, SET NULL | |
| `created_at` / `updated_at` | timestamp | |

All three tables use the project's entity vocabulary `name` + `description`.
`content` lives in Postgres, not on a volume, for the same reasons
`skill_file.content` does: transactional with its metadata, SQL-listable,
covered by `pg_dump`.

Binding ([src/lib/db/schema.ts:1193](file:///d:/AI/nango/src/lib/db/schema.ts#L1193))

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
- `unique (kb_group.collection_id, name)`, `index (kb_group.collection_id, parent_id)`, `CHECK (id <> parent_id)`
- `unique (kb_page.collection_id, name)`, `index (kb_page.collection_id, group_id)`, `CHECK (content_type IN (…six text types…))`

### 3.3 Where each rule is enforced

A DB CHECK fires on every write path — API, service, hand-run SQL, future script.
A service check only covers paths that go through the service. A CHECK can only
see one row.

| Rule | Home | Why |
|---|---|---|
| `content_type` in the six-value set | DB CHECK | A `application/pdf` row slipping in makes every later reader assume UTF-8 and return mojibake. |
| `group.parent_id <> group.id` | DB CHECK | Same-row comparison. |
| `name` uniqueness | Unique index | Also mapped to `409 NAME_TAKEN` (§5). |
| Group depth ≤ 2 levels | Service | Needs the parent's parent. |
| No `a → b → a` cycle | Service | Recursive walk across rows. |
| A parent group cannot be deleted under its children | RESTRICT FK + `409 GROUP_HAS_CHILDREN` in the service | Silently promoting children rewrites the author's structure. |
| Page/group `group_id` belongs to this collection | Service | Cross-row. |
| `kb.max_pages` / `kb.max_groups` / `kb.page_max_bytes` | Service | Config-backed budgets, and the refusal must quote the measured value and the limit. |
| `content` is storable text — no unpaired surrogate | Service | Postgres fails the row with `22021`, which would surface as an opaque 500. |
| Slug pattern, description floor and ceiling, `content` non-empty, unknown body keys refused | API edge (Zod `.strict()`) | Typed `400 VALIDATION_FAILED` with the offending path, before any DB call. |
| Visibility / edit / ownership | `src/lib/kb/access.ts` | §13. |

**Known limitation — text validation is narrow.** `assertValidText` (§5) runs only
on `content`, and only looks for unpaired surrogates. A NUL (`U+0000`) is checked
nowhere — not in `content`, `name`, `description` or `source_ref` — and Postgres
rejects the row with `22021`, which surfaces as an opaque 500 instead of
`400 INVALID_TEXT`. A name or description carrying an unpaired surrogate is not
pre-validated either. The row is never written, so this is a wrong error code, not
stored corruption; fixing it means widening both the fields and the character set
`assertValidText` covers.

### 3.4 Ownership columns are SET NULL

`created_by` / `updated_by` on all three tables use `ON DELETE SET NULL`. A KB is a
shared asset: a hard user purge must not destroy the corpus its agents read. Two
consequences, both intended:

- `ResourceWithRBAC.createdBy` is already `string | null`
  ([src/lib/auth/permissions.ts:107](file:///d:/AI/nango/src/lib/auth/permissions.ts#L107)): an orphaned **public** row stays editable by any editor, an orphaned **private** one only by an admin.
- A **private** orphaned collection is invisible to everyone but an admin
  (`visibilitySql` compares `created_by = <uid>`, false against NULL). Content
  survives; recovery means an admin re-shares or re-owns it.

`skill`, `data_source` and `artifact` CASCADE on `created_by` because their rows are
one user's resource; the KB tables break that pattern because their rows are shared
knowledge.

## 4. Module map

| Path | Responsibility |
|---|---|
| `src/lib/db/schema.ts` | The three tables + the junction column. |
| `src/lib/kb/limits.ts` | Authored-string constants (`MAX_DESCRIPTION_CHARS`, `MIN_DESCRIPTION_CHARS`, `MAX_LABEL_CHARS`, `MAX_GROUP_DEPTH`). Client-readable. |
| `src/lib/kb/budgets.ts` | Config-backed byte/count ceilings behind `import "server-only"`. |
| `src/lib/kb/validation.ts` | Shared Zod edge schemas + `parseRowId`. Imported by the client so it cannot be told a different limit than the server enforces. No `server-only`. |
| `src/lib/kb/access.ts` | URL id → authorised collection row; the three authoring gates, the bind-time grant gate and `requireRowId`. |
| `src/lib/kb/service.ts` | All structural invariants and budgets for the authoring surface; typed `ApiError`s; the single sort site for the tree. |
| `src/app/api/kb/**` | Six route handlers (§14). |
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

- **Names.** A unique violation (`23505`) becomes `409 NAME_TAKEN` with the name;
  any other constraint error is rethrown untouched, so a real DB fault never
  masquerades as a collision.
- **Empty patch.** `updateCollection` / `updateGroup` / `updatePage` throw
  `400 No fields to update.` before touching the DB.
- **Partial `set`.** Each writer sends only its own fields — the pane writes
  `description` + `content`, the identity dialog writes `name` / `groupId` /
  `sourceRef` — so the two never step on each other.
- **Group create.** `requireLevelOneParent` refuses a level-2 parent
  (`400 DEPTH_EXCEEDED`); a new group with no parent lands at level 1;
  `assertGroupLimit` refuses past `kb.max_groups` (`400 LIMIT_REACHED`).
- **Group move** (`assertMoveLegal`, only when `parentId` actually changes):
  self-parent `400`; a target outside the collection `404`; walking up from the
  target reaching the moved node is `400 CYCLE_REJECTED`; landing level +
  `measureSubtreeHeight` past `MAX_GROUP_DEPTH` is `400 DEPTH_EXCEEDED`. Depth and
  cycle checks read the collection's whole group set — bounded by `kb.max_groups`,
  so it is one small read.
- **Page create/update.** `requirePayloadGroup` treats a `groupId` in the request
  body that points at another collection as a malformed payload
  (`400 GROUP_NOT_IN_COLLECTION`), while the same id in a URL path segment is a
  wrong address (`404` via `loadGroup`). `assertPageLimit` enforces `kb.max_pages`;
  `assertContentFits` measures `Buffer.byteLength(content, "utf8")` against
  `kb.page_max_bytes` and reports `{reason: "PAGE_TOO_LARGE", sizeBytes, maxBytes}`;
  `assertValidText` refuses an unpaired surrogate (`400 INVALID_TEXT`); `size` is
  re-measured whenever `content` is written and left alone otherwise. Text
  validation covers `content` only — names, descriptions and `source_ref` are not
  scanned; see the limitation in §3.3.
- **Audit.** Collection and page writes stamp `updatedBy` + `updatedAt`; group
  writes stamp nothing.

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
`knowledge` id through `filterBindableKbCollectionIds` before inserting the tool
rows: only ids visible to the session **and** enabled are written. An id that no
longer resolves — deleted, hidden, or disabled — is **dropped from the binding
rather than rejected**. The picker can only render what `GET /api/kb` returns, so
a collection that turned private or disabled after it was bound would otherwise
be impossible to uncheck, and every save of that agent would fail. Dropping is
equally safe: an unbindable id is never written, so the RBAC-free runtime never
sees a grant the binder could not see. The picker's client-side list is still not
a check — the API accepts any uuid and decides server-side.

At dispatch, [src/lib/runner/dispatch/builtin.ts:267](file:///d:/AI/nango/src/lib/runner/dispatch/builtin.ts#L267)
collects `tool.kind === "knowledge"` into `kbCollectionIds`, then:

1. `buildKbPromptBlock(kbCollectionIds)` runs on **every** dispatch — three
   indexed queries for the whole bound set, no byte budget, no cache. The result
   is concatenated only when non-empty.
2. When `kbCollectionIds.length > 0`, `buildListKbPagesTool` and
   `buildReadKbPageTool` are constructed with `{ agentKbCollectionIds }` and
   appended to the server tools. Both are **absent from `BUILTIN_TOOLS`**: the
   pair is a capability of the binding, not a user-tickable catalog entry — the
   same shape as the data-source and SSH auto-mounts.
3. Both tools are members of `APPROVAL_EXEMPT_TOOLS`
   ([src/lib/runner/dispatch/builtin.ts:576](file:///d:/AI/nango/src/lib/runner/dispatch/builtin.ts#L576)):
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
to see its index, then `read_kb_page(kb_name, page_name)` for the page you need.
Page bodies are never shown here — do not assume you know a KB's contents
from the lines below.

- **visionworks-pages**: VisionWorks is a data-analysis web application …
  - module-a-geo (3 pages) — Geometry layer: coordinate systems, projections.
    - module-a-geo-perf (2 pages) — Measured cost of the projection cache.
  - module-a-topology (2 pages) — Network topology model and edge weights.
  - (2 ungrouped pages)
- **x-manual**: Installation and operations manual for product X …
  - chapter-01-install (6 pages) — Bare-metal and container install paths.
  - chapter-02-config (9 pages) — Config keys and their defaults.
- **team-notes**: Weekly notes from the platform team …
  - (12 ungrouped pages)
```

Rules of the render:

- Collections alphabetically by `name`; only `enabled` rows appear.
- One line per collection: `- **<name>**: <description>`.
- One line per group: `- <name> (<N> pages) — <description>`, two spaces deeper
  for a level-1 group, four for its children, each level-1 group immediately
  followed by its own children.
- `N` counts the pages sitting **in that group**, not its subtree — the subtree is
  one `list_kb_pages` away by design.
- A trailing `- (<N> ungrouped pages)` when the collection has root pages.
  `group_id` is nullable, so a flat collection is a legitimate shape; without this
  line it would render as description-plus-zero-bullets and read as empty. The
  count is not addressable — those pages are reachable by `page_name` alone, which
  is why the wording says `ungrouped` and not `direct`.
- Nothing below group level, always, regardless of collection size.
- **SECURITY:** names and descriptions are whitespace-flattened
  (`flatten()` in the same file) before rendering. This text is author-written and
  lands in the system prompt, so a newline in a description must not mint its own
  bullet and imitate another collection.
- **Known limitation — a flattened group name may not be a usable handle.**
  `flatten()` collapses every whitespace run, but `list_kb_pages(group_name)`
  matches the stored name exactly (§7.3). A group named with a newline or repeated
  inner spaces therefore prints in the block as a single-spaced label that no
  longer matches the argument. The agent can still recover the group from the
  whole-collection listing — `list_kb_pages` prints stored names verbatim — so
  nothing is lost, but the block's own label can miss. Page names never enter the
  block, so page handles are unaffected. The repair is renaming the group to a
  single-spaced form, not relaxing the matcher: flattening is the SECURITY rule
  above, and the exact match is what makes a name a name.
- `promptBlock` is `""` when no usable collection is bound, and the caller skips
  the concatenation.

### 7.2 What the block costs, and why nothing clips it

Resident size is bounded **at write time** by the structural caps: `kb.max_groups`
per collection, `MAX_DESCRIPTION_CHARS` 512, `MAX_LABEL_CHARS` 200. Worst case at
both defaults is ≈14.5 KB of ASCII for one collection — CJK roughly triples it,
since caps count characters while the block counts bytes.

There is **no mount byte budget**, so nothing is silently dropped and no
residual-pointer hint is needed. Truncation is the failure mode this rules out: an
agent that sees 8 of 20 chapters answers "the KB has no chapter about Y" with full
confidence, so the choice is between an occasionally large prompt — visible, the
author's own edit to undo, and paid in tokens — and an occasionally blind agent. The
bound is a write-time one: `kb.max_groups` and the description and name caps, with
the configured number quoted in the refusal (§11). The editor shows the
collection's top-level count and each group's page count; it shows no mount byte
size, because reading that accurately means running the block renderer on every list
request. An author who wants a smaller mount shrinks the KB.

The same reasoning covers `list_kb_pages`, which is larger than the resident block
by design: at `kb.max_pages` the page names plus descriptions cost ≈35 KB of ASCII
for one call. Page descriptions are the second-level routing signal — the agent
picks which of 50 pages to open from them — so clipping them trades a token bill
for a blind agent. It is one call, released back into history on the next turn, and
takes no budget key.

### 7.3 `list_kb_pages`

`src/lib/kb/lookup.ts` is the agent-side read layer: **no RBAC**, because binding
the collection is the grant. The authoring surface (`service.ts` + routes) is where
visibility is evaluated, exactly as skills and data sources already work.

`getKbIndex(collectionId)` runs two queries (groups, then page summaries — the
page projection is exactly `name`, `description`, `groupId`, so a body never
leaves the DB on this path) and returns:

- `groups`: level-1 groups each followed by their children, both alphabetically,
  each with `name`, `description`, `parentName` and its `pages` list;
- `ungroupedPages`: pages with `group_id IS NULL`, alphabetically.

Row ids stay internal: an agent addresses a group by name or not at all.

With `group_name`, the response holds that group **and its level-2 children** —
resolving a level-1 group to its whole subtree is what keeps a two-level tree from
hiding content behind a second call — plus an empty `ungroupedPages` and the
echoed `groupName`. Without it, the whole index.

Typical reach for one question: small flat collection, block → `list_kb_pages` →
`read_kb_page` (**2 hops**); 20-chapter manual, **3 hops**. The extra hop for large
collections is the price of a small resident prompt, and is not configurable.

### 7.4 Ordering: natural sort applied in JS on every read

All levels order by `name` with `alphabeticCompare`
([src/lib/utils/sort.ts](file:///d:/AI/nango/src/lib/utils/sort.ts)) — the shared
numeric-aware comparator used by frontend lists and backend runners to prevent
ordering drift.

**CONTRACT:** Postgres sorts bytes without `COLLATE`, so `ORDER BY name` alone puts
`chapter-10` before `chapter-2`. Every KB list read applies `alphabeticCompare` in
JS after the SQL read — the same two-step the evaluation, verification and web-auto
storage layers use. This covers `service.getTree` (sorted once, so the editor tree
and the agent index cannot diverge), `lookup.listEnabledKbCollectionsByIds`,
`lookup.orderGroupTree` and the block renderer. The failure is silent if missed: a
byte-ordered chapter list looks plausible to both agent and author.

There is no `display_order` column: a manual ordering field is what you add after
natural sort turns out wrong for the content, and `chapter-NN` names already order
correctly under it.

## 8. Flow D — `read_kb_page` windowing

Every format is line-windowed, because "stored verbatim" and "fits in one tool
response" are separate questions: a 200 KB CSV is legitimate final form and
illegitimate as a single context injection.

`windowByLine` in [src/lib/kb/runtime-tools.ts:259](file:///d:/AI/nango/src/lib/kb/runtime-tools.ts#L259):

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
- Envelope: `ok`, `kbName`, `pageName`, `description`, `contentType`, `content`,
  `startLine`, `endLine`, `totalLines`, `truncated`, `nextOffset?`, `note?`.
  `source_ref` is never among them.

## 9. Flow E — deletion

All deletes are hard. A tombstone on these tables would have to be filtered out of
every read path including the block, and nothing here needs recoverability beyond
what `pg_dump` already gives.

| Delete | What happens |
|---|---|
| Collection | `kb_group` and `kb_page` cascade; `builtin_agent_tool` rows release the binding; the next dispatch renders no block for it. Author or admin only (`loadOwnedCollection`). |
| Group | Refused `409 GROUP_HAS_CHILDREN` (with `childGroupCount`) while it still has nested groups. Otherwise, inside `db.transaction`: delete every page carrying this `group_id`, then the group. The RESTRICT refusal is what makes the page delete complete — with children ruled out, the rows holding this `group_id` *are* the whole subtree, so nothing is left pointing at a vanished group. `kb_page.group_id`'s `SET NULL` stays as the DB-side safety net for a hand-run `DELETE`; the service is the only path that turns "delete the group" into "delete its pages". |
| Page | `404` check first, then a single delete. |

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
names and group names carry the entire recall surface**: the usual diagnosis is
"the page exists but its name does not say so", and the usual repair is a rename or
a sharper `description`, not a new page.

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
| `MAX_DESCRIPTION_CHARS` | 512 | `src/lib/kb/limits.ts` | One `description` at any level. KB descriptions are the only ones in this project injected *en masse*, so they sit below the 1000-char caps used by skill frontmatter and suite descriptions. |
| `MIN_DESCRIPTION_CHARS` | 10 | same | Collection and group `description`. A short-but-present one renders as a confident routing line that routes nowhere, so it is refused at the write edge (`trim()` first, then the min — whitespace-only fails). Page descriptions are exempt. |
| `MAX_LABEL_CHARS` | 200 | same | Group and page `name`, and `source_ref`. |
| `MAX_GROUP_DEPTH` | 2 | same | Levels below a collection; stated in the runtime index, the tree UI and the move checks. Client-readable, unlike the budgets. |
| `kb.page_max_bytes` | 262144 | `src/lib/kb/budgets.ts` + config | One page's stored `content`. |
| `kb.read_max_bytes` | 65536 | same | One `read_kb_page` response — a context-flooding guard, not a write limit; floors at 1 byte (§8); the stored-vs-returned pair mirrors `host.file.write_max_bytes` / `read_max_bytes`. |
| `kb.max_pages` | 50 | same | Pages per collection. |
| `kb.max_groups` | 20 | same | Groups per collection, and therefore the ceiling on injected index lines. |

Not configurable: group depth, text-only `content_type`, collection-level
mount granularity. All values assume a personal / small-team corpus on one Node
process, matching the project's runtime boundary.

## 12. Tool surface

| Tool | Arguments | Success envelope |
|---|---|---|
| `list_kb_pages` | `kb_name` (required, 1–63), `group_name` (optional, exact match) | `{ ok, kbName, description, groups[], ungroupedPages[], groupName? }` |
| `read_kb_page` | `kb_name`, `page_name` (required, exact), `offset?`, `limit?` | `{ ok, kbName, pageName, description, contentType, content, startLine, endLine, totalLines, truncated, nextOffset?, note? }` |

Argument spelling follows the house split: multi-word tool **arguments** are
snake_case (`data_source_name`, `calendar_name`, `target_path`), **response fields**
are camelCase like `read_file`'s `startLine` / `sizeBytes`. `kb_name` / `page_name`
are spelled out because `collection` next to `page` reads as ambiguous. The stored
entity stays `kb_collection`; only the tool surface says `kb`.

**CONTRACT — failure envelopes.** Exactly three codes, and each names the reason
and nothing else:

| Code | When |
|---|---|
| `KB_NOT_AVAILABLE` | Unknown slug, collection bound to a different agent, or disabled — deliberately one indistinguishable answer, because distinguishing them would let a tool call enumerate which KBs a deployment has. |
| `NO_SUCH_PAGE` | `page_name` is not in that collection's index. |
| `GROUP_NOT_FOUND` | `group_name` is not in that collection's index. |

No failure returns the list of valid names. `list_kb_pages` is the discovery tool
and `## Available knowledge` is the discovery channel; an error path is not one, and
an `available` array would duplicate the tool, cost 50 names × 200 characters on the
one path nobody asked to read, and arrive as a side effect of a mistake.
Failures also short-circuit reads: `resolveKbCollectionForAgent` runs before the
index or page query, and returns `null` without querying for an empty binding set.

Risk classification: `low` / `sideEffects: "read"` / `readOnlyHint` /
`headlessAllowed`, and both are approval-exempt (§6).

## 13. Access model

Page guard: `src/app/(workspace)/kb/layout.tsx` → `requireEditor`. Sidebar entry
`kb` ("Knowledge") is `requiredRole: "editor"`
([src/components/layout/sidebar-panel-registry.tsx:121](file:///d:/AI/nango/src/components/layout/sidebar-panel-registry.tsx#L121)).

| Gate | Home | Failure | Used by |
|---|---|---|---|
| Visible (own, public, or admin) | `loadVisibleCollection` | `404 NOT_FOUND` — hidden and missing are identical, so private ids stay opaque | `GET /api/kb/[id]`, `GET …/pages/[pageId]` |
| Content write | `loadEditableCollection` | `403 FORBIDDEN` | all POST/PATCH/DELETE routes |
| Strict ownership — `enabled`, `visibility`, collection delete | `loadOwnedCollection`, plus `canChangeVisibility` for the two fields | `403 FORBIDDEN` | `DELETE /api/kb/[id]`; the two fields inside `PATCH /api/kb/[id]` |
| Bindable — visible **and** enabled | `filterBindableKbCollectionIds` | Ids that fail are silently dropped from the save; the rest are bound | `POST /api/builtin-agents`, `PATCH /api/builtin-agents/[id]` when tools are replaced (§6) |
| Malformed uuid segment | `UUID_RE` pre-check | `404` before any query — a non-uuid can never match the column and Postgres would surface it as a 500 | all `[id]` routes |
| bigint row id in the path | `requireRowId` | `400` "group/page id must be a positive integer." | group/page routes |

A public collection another editor authored can be read and improved but **not
unmounted or made private** — that asymmetry is the whole reason the strict gate is
separate from the edit gate.

Hidden ≡ missing holds for the **read** gate only. The write gates load the row by
id before checking the right, so a private collection id the session cannot see
answers `403`, while an unknown id answers `404`. Skills instead runs its
visibility check first on every method and hides both behind `404`; the KB
divergence is deliberate — on a write route the caller already names the row it
means to change.

Runtime is RBAC-free by design (§7.3) — because the bind filter settled each
grant once (§6): `resolveKbCollectionForAgent(name,
allowedIds)` checks only that the id is in the agent's own bound set and the row is
`enabled`. That also means visibility is never re-evaluated against the runner;
see §13.1.

### 13.1 Known limitation — visibility is not re-checked at run time

The bind filter evaluates **the binder's** session once, when the agent is saved.
The runtime checks only that the collection is still `enabled` and that its id is
in the agent's bound set; it never asks whether the user running the agent can see
that collection (§7.3). A **public** agent is runnable by any signed-in user, so
once the KB and the agent have different audiences, the runner still receives the
collection's name, description and derived index, and `read_kb_page` still returns
its full text. Two flips reach this state:

- the collection turns from public to private after it was bound;
- the agent turns from private to public after a private collection was bound to
  it.

Neither flip revokes the grant, because neither touches `builtin_agent_tool`. The
only revocation points are the owner unbinding the KB in an editor save, a save of
the agent's tools by an editor who cannot see the collection (the filter drops it,
§6), or deleting / disabling the collection. Until a flip is paired with one of
those, the exposure is real: `visibility` on `kb_collection` is an
authoring-surface control, not a runtime one.

This is a known gap, not the intended model. The intended model is that the
binding is the grant **and the binder could see what they granted**; the gap is
that the grant travels with the agent, not with the binder. Closing it means
re-evaluating visibility against the runner on every KB read, which the
RBAC-free runtime deliberately avoids; the gap is documented rather than hidden.
Operationally: re-check an agent's Knowledge tab before making a KB private, and
before publishing an agent that binds a private KB.

## 14. API surface

| Method + path | Wrapper | Behavior |
|---|---|---|
| `GET /api/kb` | `withSession` | Visible collections, newest first, each with `topLevelGroupCount` (level-1 only) and `pageCount` — two `GROUP BY` queries for the whole set. |
| `POST /api/kb` | `withEditor` | `{name, description, visibility?}` `.strict()` → `201`. Private by default; `createdBy`/`updatedBy` from the session. |
| `GET /api/kb/[id]` | `withSession` | Collection row + `{groups, pages}` in agent order, no page bodies. |
| `PATCH /api/kb/[id]` | `withEditor` | Two gates: content (including the slug) under the edit gate; `enabled`/`visibility` under `canChangeVisibility`. `400` on an empty patch. |
| `DELETE /api/kb/[id]` | `withEditor` | Strict gate → `204`. Hard delete with cascade. |
| `POST /api/kb/[id]/groups` | `withEditor` | `{name, description, parentId?}` → `201`. |
| `PATCH /api/kb/[id]/groups/[groupId]` | `withEditor` | Rename / re-describe / move → `200`. |
| `DELETE /api/kb/[id]/groups/[groupId]` | `withEditor` | `204`, or `409 GROUP_HAS_CHILDREN`. Deletes the group's pages. |
| `POST /api/kb/[id]/pages` | `withEditor` | `{name, description?, groupId?, content, contentType?, sourceRef?}`; `content` `min(1)` and untrimmed → `201` with computed `size`. |
| `GET /api/kb/[id]/pages/[pageId]` | `withSession` | The only human-facing read that returns `content`. |
| `PATCH /api/kb/[id]/pages/[pageId]` | `withEditor` | Partial update; `groupId` moves the page; re-measures `size` only when `content` is written. |
| `DELETE /api/kb/[id]/pages/[pageId]` | `withEditor` | `204`. |

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
| `KbTree` | Its own `Pages (pageCount)` header carries the two create actions (New group, New page), absent rather than disabled for a viewer who cannot edit. Level-1 groups with children nested and their pages under them; ungrouped pages as bare rows at the tail, with no heading — a bucket label would be a group name the server refuses, folds nothing and renames nothing. A group row is a disclosure control only: its chevron folds the subtree and touches nothing in the detail pane, because a group has no body. Only a page row selects. Folds are held in a client *collapsed* set so a write that reloads the tree cannot undo what the author just folded. Tree starts expanded. Every row surfaces pencil + trash on hover; the trash describes **the row it sits on**, looked up by id. |
| `KbGroupDialog` | Whole life of a group in one component: create (`POST`) or edit (`PATCH`) with the same fields (name, description, parent). Writes by itself, renders the refusal inline, signals the editor to refetch — `onSaved` is a signal, not a payload, because the caller already holds the tree. Offers **Top level** and level-1 parents only; a group that already owns children is pinned to level 1 rather than offered a parent the server would refuse; a new group starts at level 1. |
| `KbPageDialog` | A page's identity only — group, name, source. In create mode it hands the answers to the pane instead of posting (`POST` refuses empty `content`, and an agent-visible empty page is worse than an extra click); in edit mode it sends the `PATCH` of its three fields and renders the refusal inline. Its Group select opens on the group of the page in view, or **Top level**. Level-2 options are spelled with a leading em dash through one helper so option text and its `label` cannot drift. |
| Detail pane | The selected page's `description` + body, nothing else — name, group and source are the dialog's, `content_type` has no control. Saved by the header **Save**. Opens with nothing selected and one line of prompt, because neither the collection nor a group has a form here. |

Cross-cutting UI rules:

- **One tally rule.** `kbTopTally` in [src/lib/types/kb.ts:37](file:///d:/AI/nango/src/lib/types/kb.ts#L37):
  level-1 groups when the collection has any, otherwise its pages — a flat
  collection is not empty and a `(0)` would say otherwise. The panel's number is
  server-computed (`GET /api/kb` counts `parent_id IS NULL` groups specifically, so
  the two agree); the editor header derives its own from the arrays the tree route
  already returned, which keeps it exact after every write at no second query.
- **A pending create is visible.** A page whose identity the dialog confirmed but
  whose body is unposted renders as a draft row in the group it was aimed at —
  selected, marked dirty, action-less, the only row without a database row behind
  it. It becomes real on the `POST`, and Save keeps the label "Save" in both states.
  A draft aimed at a group that is then deleted loses its home and is dropped.
- **Page bodies are plain textareas.** No Markdown preview, no rendered view, no
  format picker, no in-app table or tree editor: these pages are what an agent
  reads, `content_type` is only a parse hint the server defaults, and a CSV or JSON
  page is an exported artifact of another system whose quoting and delimiter
  invariants freeform editing breaks — you change one by replacing the whole body.
- **Description floors are shown, not spent.** Every form that writes a collection
  or group description carries a counter that turns destructive under
  `MIN_DESCRIPTION_CHARS` and disables submit. Page descriptions are optional and
  capped only, so `maxLength` enforces their bound and the pane prints no counter.
- Renaming is the dangerous corner: `kb_collection.name` and `kb_group.name` are
  strings agents already hold mid-conversation. The write edge enforces the slug
  rule, the dialog states it on failure, and nothing broadcasts a rename. An open
  editor keeps showing the old collection name in its header until its next write
  refreshes the tree.
- **Selects need `label`.** Base UI `Select` renders the closed state from each
  option's `label`, not its children, so an item written with only children shows
  the raw group id the moment it is chosen.
- **Permission gating** uses the shared `useResourcePermissions` hook; a denied
  action renders a static `<span>` where the button was, or nothing where the action
  has no read-only meaning — never a disabled button. The panel gates the toggles on
  `canChangeVisibility` and the pencil on `canEdit`. In the editor `canEdit` decides
  nothing beyond `readOnly` and which controls appear, because any collection that
  loads already passed `loadVisibleCollection`; it is the single `editable` flag the
  tree reads, and it removes both create actions and every row's pencil and trash
  together. `canDelete` alone gates the header Delete. The hook settles a beat after
  mount so the action cluster appears rather than flashing "Read-only" at an author.
- The center pane is **not** wired to `useCopilotDraft`: that mechanism exists so an
  agent can rewrite a resource, and agents cannot write knowledge.

## 16. Tests

| File | Covers |
|---|---|
| `tests/unit/lib/kb/service.test.ts` | Write edges and budgets: list tallies, natural sort on both tree branches, `404` guards that fire before a mutation, private-by-default and audit stamps, empty-patch `400` before any query, `NAME_TAKEN` only for `23505` (other errors rethrown untouched), depth/cycle/self-parent moves, `GROUP_HAS_CHILDREN` plus the two-delete transaction order, byte-`size` re-measure, CJK `PAGE_TOO_LARGE`, `INVALID_TEXT`, page/group ceilings, `GROUP_NOT_IN_COLLECTION`. |
| `tests/unit/lib/kb/lookup.test.ts` | No query for an empty id set; natural order of mounted collections; unbound vs. disabled indistinguishable; group-tree order with `parentName`; page bucketing and the ungrouped tail; exact projections (index omits `content`, page read omits `sourceRef`); two queries per index. |
| `tests/unit/lib/kb/runtime-tools.test.ts` | Full vs. `group_name` subtree views; case-sensitive misses; the three envelopes with no discovery payload; line windowing under a byte budget, `nextOffset` continuation, mid-line cut + `note`; LF normalisation; partial code point dropped; `limit` vs. budget precedence; out-of-range offset → empty window; reads short-circuited when resolution fails. |
| `tests/unit/lib/kb/prompt-block.test.ts` | Empty/disabled bindings render `""` with no reads; one read pass per level regardless of count; exact bullet lines and indentation; stops at group level; counts scoped per collection; legacy NULL description; whitespace flattening cannot mint a bullet; no trailing newline. |
| `tests/unit/app/api/kb-routes.test.ts` | All six real route handlers end to end: role gates (`401`/`403`), malformed ids, slug and description refusals, `.strict()` unknown keys, two-gate PATCH, `204`/`409` deletes, tree projection, verbatim `content` and computed `size`, `contentType` enum, `kb.max_pages` refusal message. |
| `tests/unit/app/api/builtin-agents-route.test.ts`, `builtin-agent-id-route.test.ts` | The bind filter on create and on tool replacement: a deleted, hidden or disabled id is dropped while the save still succeeds; bindable ids in the same save survive; non-knowledge bindings are never dropped. |
| `tests/unit/lib/runner/dispatch-builtin.test.ts` | Binding mounts both tools with the agent's id set and injects the block; unbound renders nothing and builds nothing; slot order Calendars → knowledge → Charts. |
| `tests/unit/lib/agent-pipeline/risk-registry.test.ts` | Both tools evaluate `low` / `read` / no approval / headless-allowed. |

```bash
pnpm test -- tests/unit/lib/kb tests/unit/app/api/kb-routes.test.ts
pnpm check-types && pnpm lint && pnpm comments:check:all
```

Schema changes go through `pnpm db:generate --name=<name>` and commit both the SQL
and the `meta/` snapshot (AGENTS.md rule 7).
