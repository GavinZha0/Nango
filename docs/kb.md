# Knowledge Base

> Audience: backend / frontend engineers implementing the KB subsystem
> See also: `docs/skills.md`, `docs/data-sources.md`, `docs/prompts.md`,
> `docs/architecture.md`, `docs/rbac.md`

The KB is an **LLM-wiki**: knowledge is written once, condensed once, and
read many times by agents. There is **no vector store, no embedding model,
no tokenizer extension, and no sidecar service**. Retrieval is navigation —
an agent walks an index the same way a human does.

Two KB modes coexist in Nango:

1. **External RAG** (e.g. RagFlow) — read-only query interface wrapped as an
   MCP server. No state lives in Nango. Out of scope for this doc.
2. **LLM wiki** — this doc. Nango-managed, text-only, index-driven.

---

## 1. The one structural idea: three disclosure levels, two storage levels

The design deliberately separates *what we store* from *how deep you
navigate*.

| Disclosure level | What an agent sees | Stored? |
|---|---|---|
| 1. Collection | `name` + `description` | Yes — `kb_collection` |
| 2. Group | group name + group description + page count | Yes — `kb_group` |
| 3. Page | the content itself | Yes — `kb_page` |

There is **no fourth level**. The original document a page was distilled
from is *not* stored anywhere in this system (§5).

Storage is therefore two tables plus one junction column, and navigation is
three levels. Injection is capped at level 2 (§4).

### What each level is for

- **Collection** — a coherent body of knowledge with one identity:
  "VisionWorks system pages", "X product manual". This is the **only** unit
  that can be mounted on an agent (§4.1).
- **Group** — a chapter, module, or section. Exists so a large collection can
  be navigated without ever putting all page names into a resident prompt.
- **Page** — one unit of knowledge. Markdown, CSV, or plain text. This is the
  atom both the editor tree and `read_kb_page` address.

### Condensation is per-page, and optional

Not every page is a summary. The rule is *content form follows use*:

| Source | Handling |
|---|---|
| A 10 KB CSV of page names / URLs / descriptions | Stored **verbatim**. Already final form; condensing it would only lose rows. |
| Meeting notes, email digests, design decisions, config notes | Written directly as a page. There is no external original. |
| A 200-page PDF manual | Extracted and condensed into Markdown pages externally, then pasted in. One page per chapter or topic. |

The system never inspects content to decide which bucket it falls into. That
judgement belongs to the author (§5.2).

---

## 2. Progressive disclosure

When a built-in agent has KB collections bound, the runtime injects a
**capability block** that stops at level 2, and auto-mounts two tools:

| Tool | Returns |
|---|---|
| `list_kb_pages(kb_name, group_name?)` | The collection's derived index: each group with its `description`, page count and page lines, plus the collection `description`. With `group_name`, only that group **and its level-2 children** — resolving a level-1 group to its whole subtree is what keeps a two-level tree from hiding content behind a second call. Pages with no group come back under `ungroupedPages` and are **never addressable** by `group_name`. |
| `read_kb_page(kb_name, page_name, offset?, limit?)` | One page's text, windowed by line. |

**CONTRACT:** a failure envelope names the reason and nothing else. There is no
`available` array on `NO_SUCH_PAGE` or `GROUP_NOT_FOUND`: `list_kb_pages` is the
discovery tool, and the set of readable collections is already in the agent's
prompt block (§4.2). An existing violation of this rule lives in `get_skill`
(`src/lib/skills/runtime-tools.ts`), whose failure path does return `available` —
recorded for cleanup, deliberately not fixed inside the KB work.

Three codes exist, and `KB_NOT_AVAILABLE` deliberately folds the three reasons an
argument can fail to resolve — the slug does not exist, it is bound to a
different agent, the collection is disabled — into one indistinguishable answer,
because distinguishing them would let a tool call enumerate which KBs a deployment
has. Out-of-range `offset` is not an error: past `totalLines` returns an empty
window, exactly as `read_file` does, so probing the tail costs nothing.

Token cost is bounded by the injected group lines plus one `list_kb_pages` response,
not by page bodies. Typical reach for one question:

- Small flat collection: block shows groups → `list_kb_pages` → `read_kb_page`. **2 hops.**
- 20-chapter manual: block shows 20 chapter names → `list_kb_pages` → `read_kb_page`. **3 hops.**

The extra hop for large collections is the price of keeping resident prompts
small. It is paid deliberately and is not configurable (§4.2).

### 2.1 Index is derived, never authored

**CONTRACT:** There is no `kb_index` table, column, or page. The index an
agent reads is generated from `kb_collection.description`, the `kb_group`
rows, and the page names/descriptions under them. The index the editor renders
is the same generation.

Rationale: an authored index is a second source of truth. Every page add,
delete, and rename would need a manual echo, and the echo would drift.
Deriving it means the index cannot be wrong.

The `## Available knowledge` block format follows the `## Available Skills`
discipline (`src/lib/skills/runtime-tools.ts` → `renderPromptBlock`): list
identifiers and blurbs, and **only name a tool when it is actually mounted**.

### 2.2 Ordering: natural sort, applied in JS on every read

All three levels order by `name` using `alphabeticCompare`
(`src/lib/utils/sort.ts`) — the project's shared numeric-aware comparator, whose
own header declares it is used by both frontend lists and backend runners "to
prevent ordering drift".

**CONTRACT:** Postgres sorts bytes without `COLLATE`, so `ORDER BY name` alone
puts `chapter-10` **before** `chapter-2`. Every KB list read must apply
`alphabeticCompare` in JS after the SQL order — the same two-step the eval,
verification, and web-auto storage layers use (`src/lib/evaluation/storage.ts`,
`src/lib/verification/storage.ts`, `src/lib/web-auto/storage.ts`). This covers
`list_kb_pages`'s derived index, the mounted block's group lines, and the editor tree.

The failure is silent if missed: a dictionary-ordered chapter list looks
plausible to both the agent and the author.

Sort once in the service so the tree and the agent index cannot diverge, the
reason stated in `src/app/api/skills/[id]/route.ts` for sorting on the API side
("so every consumer sees the same order instead of re-sorting client-side").

This is also why there is no `display_order` column: a manual ordering field is
what you add only after natural sort turns out to be wrong for the content, and
`chapter-NN` style names already order correctly under it.

---

## 3. Data model

### 3.1 `kb_collection`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid v4 | URL-exposed; FK target for `builtin_agent_tool.kb_collection_id` |
| `name` | text | Stable LLM-facing identifier, globally unique. Pattern `/^[a-z][a-z0-9_-]{0,62}$/` (1–63 chars) enforced at the API edge — the same rule as `DATA_SOURCE_NAME_RE`. Doubles as the panel label. |
| `description` | text NULL | What the KB is and when to use it. **This is the level-1 routing signal injected into every bound agent's prompt, so it is required at the API edge, minimum 10 characters (§6).** Capped at 512 characters. |
| `enabled` | boolean | Disabled collections vanish from the prompt block and `list_kb_pages` refuses them. |
| `visibility` | `'private' \| 'public'` | RBAC scope, same semantics as `skill`. |
| `created_by` / `updated_by` | uuid → user | ON DELETE SET NULL — see §3.7. Standard RBAC audit. |
| `created_at` / `updated_at` | timestamp | Standard. |

### 3.2 `kb_group`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | Server-internal; never in a URL. |
| `collection_id` | uuid → `kb_collection` | ON DELETE CASCADE. |
| `parent_id` | bigint → `kb_group` NULL | NULL = level-1 group. **Depth is capped at 2 group levels**, enforced in the service layer. CHECK blocks only the self-loop (§3.6). |
| `name` | text | Unique within a collection. Appears in the injected block **and** is the `group_name` argument of `list_kb_pages`, matched exactly — so no separate slug column is needed, but a rename does invalidate the names an in-flight agent already read. Capped at 200 characters (§6). |
| `description` | text NULL | Prose about *why these pages belong together* — **required at the API edge**, minimum 10 characters (§6). The column stays nullable because every `description` column in this project does; the requirement is authoring policy, not a structural invariant. Capped at 512 characters; see §3.5. |

Ordering: by `name` through the project's shared natural-sort comparator
(§2.2). There is no `display_order` column.

Primary key is bigint identity because a group is collection-owned and never
URL-addressed (AGENTS.md "Primary key choice" rule 1).

### 3.3 `kb_page`

All three tables use the project's entity-naming vocabulary — `name` +
`description`. `title` / `summary` were rejected: in this schema `title`
exists only for transient display strings (`notification.title`) and external
protocol fields (`mcp_server.server_title`), and `summary` only for run
outputs (`entity_run.output_summary`). Neither means "resource name".

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | Append-heavy child rows of one owner. |
| `collection_id` | uuid → `kb_collection` | ON DELETE CASCADE. Denormalised so "list every page in this KB" is a single-index scan and so the uniqueness rule below is expressible. |
| `group_id` | bigint → `kb_group` NULL | NULL = page sits directly under the collection. The FK is `ON DELETE SET NULL` — the conservative DB behaviour for a hand-run `DELETE` — but the service deletes a group's pages along with the group (§3.6), so nothing survives that way on an app path. |
| `name` | text | Page identifier for humans **and** the `read_kb_page(kb_name, page_name)` argument — matched exactly. **Unique within a collection, across all groups.** Capped at 200 characters (§6). |
| `description` | text NULL | One line of level-2 help, shown by `list_kb_pages`. Never injected into the resident prompt, and optional. Capped at 512 characters. |
| `content` | text | The knowledge itself, as stored bytes. PG TOAST compresses. Written **verbatim**: the API edge refuses an empty page but never trims, because a CSV or YAML page whose leading bytes change is a different artifact. |
| `content_type` | text | `'text/markdown' \| 'text/plain' \| 'text/csv' \| 'application/json' \| 'text/yaml' \| 'text/xml'`. **Text only — binary assets are rejected at the API edge.** Values are taken verbatim from `EXTENSION_TO_MIME` in `src/lib/skills/storage/skill-storage.ts`, so a future import path can reuse `guessContentType()` without colliding with the CHECK. |
| `size` | integer | Pre-computed byte length of `content`, matching `length(content)`. Mirrors `skill_file.size`. |
| `source_ref` | text NULL | Provenance, **human-facing only**. See §5. Capped at 200 characters (§6). |
| `created_by` / `updated_by` | uuid → user | ON DELETE SET NULL — see §3.7. |
| `created_at` / `updated_at` | timestamp | Standard. |

Ordering: by `name` (§2.2). No `display_order` column.

Indexes: `unique (collection_id, name)`; `(collection_id, group_id)` for tree
assembly.

`content` lives in Postgres rather than on a volume for the same reasons
`skill_file.content` does: transactional with its metadata, listed and
filtered by SQL, and covered by `pg_dump`.

### 3.4 No `kb_source_doc` table

Earlier drafts of this doc specified `kb_collection` / `kb_source_doc` /
`kb_page` plus a `KbStorage` interface with local/S3 drivers, a `trees/`
directory, and a shared Docker volume. **All of that is removed.** Its only
reason to exist was holding raw uploads inside the system, and the system no
longer holds them.

### 3.5 Group descriptions must not duplicate the index

**CONTRACT:** `kb_group.description` is prose about the group's purpose or
the relationship between its pages. It must never enumerate the group's
pages — that list is derived, and enumerating it in authored text recreates
the drift problem §2.1 removes.

This is enforced as an editor hint and a documentation rule, not by the
server: a byte heuristic on prose vs. a list would refuse legitimate
enumerative descriptions.

### 3.6 Where each rule is enforced

A DB CHECK fires on **every** write path — API, service, hand-run SQL, a future
script. A service-layer check only covers the paths that go through the
service. A CHECK can only see the columns of the row being written.

| Rule | Home | Why |
|---|---|---|
| `content_type` in the 6-value set | DB CHECK | Single-column value domain. If one write path slips a `application/pdf` through, every later reader assumes UTF-8 text and returns mojibake from an already-polluted row. |
| `group.parent_id <> group.id` | DB CHECK | Same-row comparison, expressible. |
| Group depth ≤ 2 | Service | Needs the parent's parent. |
| No `a → b → a` cycle | Service | Needs a recursive walk across rows. |
| Deleting a group that has nested groups | Service | Needs to query `kb_group`. |
| `name` uniqueness | Unique index | — |

Service-enforced rules (mirroring `src/lib/artifacts/service.ts`):

- A page must belong to exactly one collection; `collection_id` is copied
  from its group when a group is set, and rejected on mismatch.
- A group's `parent_id` must be in the same collection, and must itself be a
  level-1 group (depth cap).
- Deleting a group deletes the pages under it in the same transaction — a
  directory is removed by removing what it holds, and nothing survives
  silently. Deleting a group that still has **nested groups** is refused
  (`409 GROUP_HAS_CHILDREN`): `parent_id` is RESTRICT, and silently promoting
  children would rewrite the author's structure. That refusal is also what
  makes the page delete complete — with children ruled out, the rows holding
  this `group_id` *are* the whole subtree.
- Renaming a group is a single-row update — no descendant path rewrite, which
  is the reason this design uses a group table instead of the implicit
  folder-prefix scheme `skill_file.path` uses.
- `name` collision within a collection returns 409.
- Deleting a collection, a group or a page is a **hard delete** with cascade.
  Soft delete
  is the user-account policy in this project, not a general one; a tombstone on
  these tables would have to be filtered out of every read path and out of the
  mount block, and nothing here needs recoverability more than the DB backup
  already gives it.
- Collection and group `description` must be present and ≥ 10 characters. The
  shared edge schema (`requiredDescriptionSchema`) enforces both bounds with
  `trim()` applied first, so a whitespace-only description fails the minimum
  rather than passing a raw length check; the failure arrives as the standard
  `400 VALIDATION_FAILED` envelope with the offending path. The columns stay
  nullable in the DB — that is the house pattern for `description` and it keeps
  bulk import able to create a skeleton before filling prose.

### 3.7 Ownership columns are SET NULL, not CASCADE

`created_by` / `updated_by` on all three tables use `onDelete: "set null"`.

**Why:** a KB is a shared asset, and the alternative is irreversible — a hard
user purge would delete the collection and every page of prose under it.
Precedent for the same reasoning exists in this schema: `entity_run.credential_id`
is SET NULL specifically so removing a credential cannot
"cascade-destroy historical runs (we keep the forensic trail)".

Two consequences, both accepted:

- The RBAC layer already models this state: `ResourceWithRBAC.createdBy` is
  `string | null` (`src/lib/auth/permissions.ts`). An orphaned row is editable
  by an admin only.
- A **private** orphaned collection becomes invisible to everyone but an admin
  (`visibilitySql` matches `created_by = <uid>`, which is false against NULL).
  Content survives; recovering it means an admin re-shares or re-owns it.

**Note — this diverges from existing tables.** `skill`, `data_source`, and
`artifact` all use CASCADE on `created_by` today, and `skill-pool.ts`'s comment
claiming "FK SET NULL" is stale relative to that code. Unifying them is a
separate proposal (affects three live tables + a migration) and is deliberately
not folded into the KB work.

---

## 4. Mounting and injection

### 4.1 Binding

A new `tool_type` discriminator on the existing junction table
(`src/lib/db/schema.ts` → `BuiltinAgentToolTable`):

```
toolType = "knowledge"   →  kbCollectionId  (uuid → kb_collection, ON DELETE CASCADE)
```

plus `index("builtin_agent_tool_kb_collection_idx")` for reverse lookup
("which agents use this KB"), a new `AgentToolRef` variant
`{ kind: "knowledge"; kbCollectionId: string }` in
`src/lib/builtin-agents/agent-spec.ts`, and a `knowledge: Set<string>` in the
editor's `ToolSelections` state.

**Legacy placeholder to delete:** the agent form state already carries a
`kbEnabled: boolean` that is hard-coded `false` on load and never enters the
save payload. Per-collection junction bindings replace it — remove the field
rather than wiring it up.

**Mount granularity is collection only.** There is no group-level or
page-level binding: "what does this agent know" must stay auditable from one
list. `BuiltinAgentEditor.tsx` already reserves the `"knowledge"` Tab
(currently a "coming soon" placeholder); it becomes a real picker listing
visible collections, matching the Skills/Data sources tab, with a
`count: { selected, total }` badge.

On binding, `list_kb_pages` + `read_kb_page` auto-mount — the data-source pattern
(`src/lib/runner/dispatch/builtin.ts`, the `dataSourceIds.length > 0`
branch), not a user-tickable catalog entry. Both tools are added to the
approval-exempt tool set alongside the four skill tools: they are read-only
over operator-curated content, so prompting for approval on every lookup
would only train users to click through it.

### 4.2 Injection shape

Per bound collection, one entry:

```
## Available knowledge

When a question matches one of these knowledge bases, call `list_kb_pages(kb_name)`
to see its index, then `read_kb_page(kb_name, page_name)` for the page you need.
Page bodies are never shown here — do not assume you know a KB's contents
from the lines below.

- **visionworks-pages**: VisionWorks is a data-analysis web application ... Its pages are organised by the product's three functional modules.
  - module-a-geo (3 pages) — Geometry layer: coordinate systems, projections, map-matching thresholds.
    - module-a-geo-perf (2 pages) — Measured cost of the projection cache.
  - module-a-topology (2 pages) — Network topology model and edge weights.
  - module-c-kpi (4 pages) — KPI definitions, their SQL and their owners.
  - (2 ungrouped pages)
- **x-manual**: Installation and operations manual for product X ... Read chapter order before answering: chapters 2 and 3 define terms the later chapters assume.
  - chapter-01-install (6 pages) — Bare-metal and container install paths.
  - chapter-02-config (9 pages) — Config keys and their defaults.
  - ... 20 groups total, the `kb.max_groups` default
- **team-notes**: Weekly notes from the platform team ...
  - (12 ungrouped pages)
```

Each entry is one line: `- **<name>**: <description>` for a collection,
`- <name> (<pageCount> pages) — <description>` for a group, two spaces deeper
for a level-2 group under its parent, and `- (<N> ungrouped pages)` for the
root-page tail. A group line's page count is the pages sitting **in that group**,
not its subtree — the subtree's contents are one `list_kb_pages` away by design.
Names and descriptions are whitespace-flattened before rendering: this text is
author-written and lands in the system prompt, so a newline in a description must
not be able to mint a bullet and imitate another collection.

That is: collection `name` + `description`, then group `name` + `description` +
page count. **Nothing below group level, always, regardless of collection
size.** No "flat for small KBs" special case — a conditional rule would leave
the agent unable to predict what it already knows, and the byte saving on a
small KB is one `list_kb_pages` call.

The one exception is a **count, not a title**: when a collection has pages with
no group, it gets a trailing `(N ungrouped pages)` line. `kb_page.group_id` is
nullable by design (§3.3) — a flat collection is a legitimate shape, not
untidied inventory — and without this line such a collection renders as its
description plus zero bullets, which reads as empty. Cost is one line per
collection with root pages, against the alternative of an agent deciding the KB
has nothing in it and skipping the call entirely. The count is not addressable:
those pages are reachable by `page_name` alone, which is why the wording is
`ungrouped` rather than `direct` — it states the column's state, and it tells
the agent why no `group_name` applies. The editor does not name this bucket at
all (§8): those pages are bare rows at the tail of the tree, because a heading
would read as a group the author could fold, rename or pass as `group_name`.

### 4.3 No truncation

The block is emitted whole. There is no mount byte budget, so nothing is
silently dropped and no residual-pointer hint is needed.

Resident size is instead bounded *at write time*, by the three structural caps:
`kb.max_groups` per collection, the 512-character description cap and the
200-character group-name cap. The worst case is therefore
`max_groups × (200-char name + " (N pages)" + 512)` ≈ 14.5 KB of ASCII for one
collection filled to both defaults, and most collections are well below it
because a 512-char group description is already long prose. Non-ASCII prose is
the exception the character caps hide: caps are counted in characters while the
block is counted in bytes, so a CJK collection at the same defaults costs
roughly three times that. An author who wants a smaller mount shrinks the KB,
not the runtime. The consequence is accepted in §7.3.

### 4.4 No cache, and therefore no invalidation

Add a `knowledge` capability block into the capability-block cluster — after
the Calendar block, before the Chart block — for both the regular-agent and
supervisor composition orders (`docs/prompts.md`).

Render that block **fresh on every dispatch**, from three indexed queries
(`kb_collection` by id, `kb_group` by `collection_id`, `kb_page` by
`collection_id`) regardless of how many collections the agent binds. That is the
house pattern, not a compromise: `buildDataSourcesPromptBlock`,
`buildSshHostsPromptBlock` and `buildCalendarPromptBlock` all do exactly this in
`src/lib/runner/dispatch/builtin.ts`. Of the four binding-driven capability
families only skills carry a pool, and they need one because assembling a
`SkillSpec` parses `SKILL.md` and lists helper files — work the KB block does not
have. Three indexed queries next to a multi-second model call is not a
hot path.

**Consequence:** a KB write needs no cache invalidation. An earlier draft of this
section specified `src/lib/kb/collection-pool.ts` plus
`invalidateForKbChange(collectionId)`; both were removed before step 5, because
with nothing cached, invalidating `AgentSpec` — which holds tool refs and the
author's own prompt, never the rendered block — is machinery with no consumer.
Binding changes still invalidate through the existing agent-write path.

Do **not** add a page-content cache either. `read_kb_page` is once-per-tool-call
and must return the freshest bytes; a second cache would only create a staleness
bug.

---

## 5. Provenance: `source_ref` is a note, not a pointer

### 5.1 Contract

**CONTRACT:** `source_ref` is a free-form string for human maintenance, in
the same spirit as `skill.source` — a label, not a locator. No FK, no
validation, no path resolution, no reachability check, **and no agent tool
path ever reads it.** `read_kb_page` returns page `content` and nothing else; the
envelope does not include `source_ref`.

Because agents never fetch originals, the KB has no miss-fallback: if the
condensed pages do not answer a question, there is nothing below them to
consult. That is an accepted trade-off, not an oversight (§7.1).

### 5.2 Import is an authoring action, not a pipeline

Getting a 200-page PDF into the KB is: convert it externally, then paste the
result into the editor.

There is **no file import** in the editor — an author opens the converted text in
whatever they already use and copies it in. A page is plain text, so a picker
would only re-implement the clipboard for one step of a two-step job. The
conversion stays outside the system:

- Preferred: the user's own agent, or their own tooling (`pdftotext`,
  Word's export, a Markdown converter).
- If an agent holds a `read_file` binding, it can read a text or already
  converted source placed in the `host.file.root` mount and write the
  condensed result back through the KB editor. It cannot read a PDF —
  `read_file` is UTF-8 text only (`docs/host-files.md`).

**Rejected: an in-app PDF-ingest pipeline.** It would require binary storage
(the exact thing two-level storage removes), a converter dependency, an async
compile job, and the `kb_source_doc` state machine. The conversion happens
once per document, by a human who is deciding how to chapterise it anyway —
automating it would produce a worse page split than the one the author is
already making.

### 5.3 Staleness is a human reading `source_ref`

There is no staleness mechanism. No watcher, no scheduled re-check, no
automatic re-import, and no `imported_at` / `source_hash` columns — earlier
drafts proposed both, and both were deleted as unconsumed: nothing in the
system can act on them, and a maintainer deciding whether a page has drifted
does it by looking at `source_ref` and the source itself.

---

## 6. Budgets and limits

Two different units, deliberately:

- **Description lengths are measured in characters**, as a single fixed code
  constant shared by all three levels, not a config key. 512 is the value:
  large enough for the routing prose a collection or group needs, small enough
  that the structural caps in §4.3 do the prompt-size work without needing a
  mount budget of their own. Existing caps in this project cluster at 1000
  (`MAX_DESCRIPTION_LEN = 1_000` for skill frontmatter,
  `src/lib/skills/parser.ts`; `z.string().max(1000)` for eval / verification /
  web-auto suite descriptions) — KB sits below them because its descriptions
  are the only ones that are injected *en masse* into every bound agent.
- **Content and budget sizes are measured in stored bytes** (UTF-8) and are
  operator-tunable, consistent with the `skill.*` and `host.file.*` precedent.

Enforced at the API edge with typed errors. Tunables live in Admin → Config
under the `kb.` prefix, per `docs/config.md` — not `.env`.

| Item | Value | Home | Bounds |
|---|---|---|---|
| `MAX_DESCRIPTION_CHARS` | 512 | code constant (`src/lib/kb/limits.ts`) | One `description` at any level — collection, group, or page. |
| `MIN_DESCRIPTION_CHARS` | 10 | same constant file | Collection and group `description` must clear it; page descriptions are optional. Mirrors skill frontmatter's `MIN_DESCRIPTION_LEN`. |
| `MAX_LABEL_CHARS` | 200 | same constant file | The remaining short authored strings: group and page `name`, and a page's `source_ref`. They reach the prompt block (`name`) or the editor only (`source_ref`), so they need a ceiling but no operator knob. |
| `kb.page_max_bytes` | `262144` (256 KB) | config | One page's stored `content`. Mirrors `skill.max_file_bytes`. |
| `kb.read_max_bytes` | `65536` (64 KB) | config | One `read_kb_page` response, §6.1. The stored-vs-returned pair mirrors `host.file.write_max_bytes` / `host.file.read_max_bytes`. |
| `kb.max_pages` | `50` | config | Pages per collection. |
| `kb.max_groups` | `20` | config | Groups per collection. Also the only bound on injected group lines (§4.3). |

Non-configurable structural limits: group depth 2; text-only `content_type`;
one binding granularity (collection).

**Collection and group `description` are required, minimum 10 characters** —
mirroring skill frontmatter's `MIN_DESCRIPTION_LEN` (`src/lib/skills/parser.ts`).
Both levels are injected verbatim into every bound agent's prompt, so an empty
one still renders as a presentable line while telling the agent nothing; the bad
state has to be refused at the write edge. Page descriptions stay optional — a
page's `description` only ever appears inside a `list_kb_pages` response.

Sanity check on the largest mount the caps allow: 20 groups × ~730 bytes per
line ≈ 14.5 KB for a collection at both defaults, against a typical KB of 5–10
groups × ~200 bytes ≈ 1–2 KB. There is no runtime guard between those two
numbers, by choice — see §7.3.

### 6.1 `read_kb_page` windowing

Line-windowed for every format, because "stored verbatim" and "fits in one
tool response" are separate questions — a 200 KB CSV is legitimately final
form and illegitimate as a single context injection.

- `offset` = 1-based line index, `limit` = lines to return.
- Omitted `limit` returns from `offset` up to the remaining `kb.read_max_bytes`
  budget; the response includes `totalLines` and `nextOffset` so the agent can
  continue or widen deliberately.
- **Long lines are byte-capped within a line and reported as truncated.** This
  is what a minified single-line JSON or XML page hits: line windowing cannot
  help when the whole page is one line. The repair is on the authoring side —
  re-import it pretty-printed — and the truncation message must say so, because
  an agent otherwise loops on `offset` values that all return the same cut head.
- There is no `raw`/byte-offset mode. Adding one to rescue minified payloads
  would mean re-importing `read_file`'s `raw` semantics, which exist to serve
  exact-byte reads a KB page never needs.

**CONTRACT:** `page_name` is matched against `kb_page.name` exactly,
case-sensitively, within the collection. A miss returns
`{ ok: false, error: "NO_SUCH_PAGE" }` and **nothing else**. The error path is
not a discovery channel: the agent confirms names through `list_kb_pages`, which
already exists for that purpose. An `available` array would duplicate that tool,
cost up to 50 names × 200 characters on the one path nobody asked to read, and
arrive as a side effect of a mistake. The same rule applies to
`GROUP_NOT_FOUND`.

Both parameter names are spelled out (`kb_name`, `page_name`) rather than the
terse `collection` / `page`, which read as ambiguous next to each other. The
style follows the house split: multi-word tool **arguments** are snake_case
(`extract_dataset_by_sql`'s `data_source_name`, `fetch_calendar_events`'s
`calendar_name`, `download_file`'s `target_path`), while **response** fields are
camelCase like `read_file`'s `startLine` / `sizeBytes`. `run_ssh_command`'s
`serverName` is the one outlier. The stored entity stays `kb_collection` — only
the tool surface says `kb`.

The budget is counted in UTF-8 **bytes**, not characters, because a CJK page's
`line.length` understates its context cost by three times; a line cut at the
budget edge drops the partial code point rather than emitting a replacement
character.

---

## 7. Accepted consequences

Three properties of this design that are choices, and should be re-read before
being "fixed".

### 7.1 The derived index is the single point of retrieval failure

With no original text below the pages, a question that no page answers has no
recourse at runtime. The fix is not a mechanism; it is the maintenance loop:

1. The agent says the KB does not cover it.
2. That run is in `entity_run`; `/admin/run/[id]` shows the exact failed
   navigation.
3. A human adds or improves a page.

Consequently **page names and group names carry the entire recall surface**.
When reviewing a miss, the correct diagnosis is usually "the page exists but
its name does not say so", and the correct repair is a rename or a sharper
`description` — not a new page.

### 7.2 Agent writes are not part of this design

No `kb_write` tool. Agents read knowledge; humans own the KB. An agent writing
into the corpus means the index quality, budget enforcement, and miss review
of §7.1 all have to work without a human in the loop. Revisit only with a
concrete workflow that needs it, and if it returns, it returns behind a
per-agent toggle plus `created_by_run_id` provenance.

The one human-initiated shortcut that *is* in scope: **"Save as knowledge
page"** from an outcome, mirroring the artifact save flow
(`src/lib/artifacts/save-artifact.ts`) with its `(source_thread_id,
source_outcome_id)` idempotency-key idea. A person decides a chat result is
worth keeping; the system just opens the page form pre-filled.

### 7.3 Prompt cost is the author's, not the runtime's

There is no mount byte budget (§4.3), so nothing stops a bound collection from
carrying a large index into every run of every agent that binds it. A collection
filled to both defaults — 20 groups, every description at 512 characters — is
~14.5 KB of system prompt, permanently, and the runtime will not clip it.

**Why this is the right trade:** a mount budget would have to truncate to work,
and a truncated index is the one failure mode this design cannot tolerate — an
agent that sees 8 of 20 chapters answers "the KB has no chapter about Y" with
full confidence. Choosing between "occasionally large prompt" and
"occasionally blind agent", the first is the cheaper mistake: it is visible, it
is the author's own edit to undo, and it costs tokens rather than correctness.

The mitigation is visibility, not enforcement, and the visible numbers are the
structural ones: the editor's tree footer states `Groups 6/20 · max depth 2`, so
what the author is adding to is on screen while they add it, and the 512-character
description cap is enforced at the write edge. The panel deliberately does **not**
display a computed byte size for the rendered mount block — reading that accurately
means running the block renderer on every list request, which is a second render
path serving one number nobody can act on.

The same reasoning covers the `list_kb_pages` response, which is larger than the
resident block by design: at `kb.max_pages` a collection's page names and
descriptions cost ~35 KB of ASCII (~3× for CJK) for one call. Page descriptions
are the second-level routing signal — the agent decides which of 50 pages to
open from them — so clipping or omitting them trades a token bill for a blind
agent, which is the mistake this design refuses to make. One call, released back
into history on the next turn; no budget key.

---

## 8. UI

A panel in the existing workspace shell — the shell is already a resizable
left-list / center-editor / right-chat group, so KB registers a left-panel entry
and owns the center pane; it does not build a third three-panel layout. The
center pane is two flex columns with no drag handle between them, and every row,
header strip and dialog reuses the Skills page's class strings rather than
inventing a KB-specific shape.

| Pane | Contents |
|---|---|
| Left panel | One row per collection: `name` plus a muted `(N)` annotation **outside** the name button (so the count survives a truncated name), the description at `line-clamp-2`, then the metadata pencil, the visibility icon, and the enabled toggle, in that order. `N` is the collection's top level — its level-1 group count, or its page count when it has no groups — which is the number the editor header prints for the same KB, from the same helper. Nothing else: no mount byte size (§7.3), no reverse lookup of which agents bind it, and no delete. |
| Main panel, left column | Header `Pages (pageCount)` carrying the two create actions. Below it the group tree: level-1 groups with their pages and level-2 children nested, and the pages with no group as bare rows at the tail — no heading above them, because no group names them. A group row is a disclosure control — its chevron and folder fold or unfold its subtree, and it touches nothing in the detail pane, because there is no group body to show. Its page tally hugs the name (`Docs (7)`, left-aligned), unlike the panel row where the count sits outside the button. Each group shows its description as a second, truncated line with the full text in `title`. Every row — group or page — surfaces a pencil and a trash on hover: the pencil opens that node's metadata dialog, the trash asks before deleting the row it sits on. The collection has **no row of its own**: it is already named by the panel that opened this editor, and its metadata is edited there, so a root node would only duplicate the header. The tree starts expanded and folds are held in the client's *collapsed* set, so a write that reloads the tree cannot undo what the author just folded away. A page whose identity the dialog has confirmed but whose body has not been posted shows as a draft row in the group it was aimed at — selected, action-less, and the only row that can appear without a database row behind it. The per-collection `kb.max_groups` / `kb.max_pages` caps are budget keys behind `budgets.ts`' `import "server-only"`, so nothing here prints them — the write edge quotes the configured number in its refusal instead. |
| Main panel, right column | The selected **page**'s description and body, nothing else. Name, group and source are the dialog's; `content_type` has no control at all (see the notes below). Only a page row selects. A group is never shown here: it has no body, so its metadata is the dialog on its row. The pane opens with nothing selected and one line of prompt, because neither the collection nor a group has a form here. |

The rule behind every collection tally is `kbTopTally` in `src/lib/types/kb.ts`:
level-1 groups when the collection has any, its pages when it has none — a flat
collection is not empty, and a `(0)` beside it would say otherwise. Where the two
numbers come from differs, and that is the only asymmetry. The header's is derived
from the arrays `GET /api/kb/[id]` already returned (the tree route ships no tallies,
and deriving them locally keeps them exact after every write at no second query). The
panel's is the one count computed on the server, because `GET /api/kb` groups both
tallies for every collection in two queries — and it counts `parent_id IS NULL`
groups specifically so the two agree.

Editor notes:

- **A page body is a plain textarea, and the format is not a UI concept.** These
  pages are what an agent reads, not what a human reads, so there is no Markdown
  preview, no rendered view, and no dependency on one. There is no format picker
  either: `content_type` exists so `read_kb_page` can hand the agent a parse hint
  alongside the text, and the server supplies its default (`text/markdown`) on
  create. An author never chooses it, and no write path changes it. **No in-app
  table or tree editor** for the same reason: a CSV or JSON page is an exported
  artifact of another system, and freeform edits break quoting, delimiter, and tag
  invariants — the correct way to change one is to replace the whole body.
- A new page is made from **two places**: the dialog collects its identity (group,
  name, source), then the right pane holds the description and body and its header
  **Save** is the write. The split is forced by `POST /api/kb/[id]/pages`, which
  refuses empty `content` — a dialog that posted on its own would create an
  agent-visible empty page, which is also why there is no empty-shell page state to
  design for. The pane therefore never carries name, group or source, and the
  dialog never carries a body. The dialog's Group select opens on the group of the
  page in view, or **Top level** when none is — the last thing the author was
  looking at is the best guess at where its sibling belongs.
- Confirmed identity gets **a row immediately**, in the group the dialog named, so
  the create is visibly under way: a name typed into a dialog that closes onto an
  unchanged list reads as a failure. The row is the selection, is marked dirty while
  its body is unsaved, and carries no pencil or trash — there is no server row to
  edit, delete, or reload. It becomes a real row on the `POST`, and Save keeps its
  label in both states because the row now says what is pending. A draft aimed at a
  group that is then deleted loses its home and is dropped with it.
- A group's whole life is **one dialog**: creation from the header action, editing
  from the pencil on its row. Same fields (name, description, parent), same
  component, `POST` versus `PATCH` on whether a row came in. A group has no body,
  so there is nothing to author in the pane; the dialog writes by itself, renders
  the refusal inline, and tells the editor to refetch. Its `onSaved` is a signal,
  not a payload — the caller already holds the tree — so saving a group
  never moves the detail pane and opening a dialog needs no unsaved-changes guard:
  a dialog replaces no draft. Group state is therefore not a selection state at all;
  folding is the only thing a group row does, and it is client-local.
- A page's identity is **the same one dialog** — group, name, source — but it
  behaves differently in its two modes, because a page does have a body and the
  pane is holding it. *Create* only hands the answers to the pane; *edit* sends a
  `PATCH` of `name` / `groupId` / `sourceRef` and renders the refusal inline, the
  way the group dialog does. Since `PATCH` is partial, the two writers never step
  on each other: the pane sends `description` + `content` alone, the dialog its
  three fields alone. Editing the page that is already open therefore merges the
  server's row into **both** the draft and its baseline — otherwise the pane would
  either keep a stale name for its next save or mark itself dirty over a write it
  just made. Renaming still changes the `page_name` agents pass to `read_kb_page`;
  that is the write edge's problem, not a warning banner in the form.
- The group / parent picker in both dialogs is a **Base UI `Select`**, and its
  closed state renders each option's `label`, not its children: an item written
  with only children shows the raw string it was keyed by — a group id — the
  moment it is chosen. So every `SelectItem` carries `label` alongside its
  children, and `SelectValue` resolves the current id back to a name itself. The
  page dialog also offers level-2 groups, and spells them with a leading em dash
  through one helper so the option text and its `label` cannot drift apart; the
  group dialog offers level-1 parents only, so their names need no decoration.
- The collection / group `description` floor is enforced in every form that writes
  it — the panel's dialog and the group dialog — as a counter that turns
  destructive under `MIN_DESCRIPTION_CHARS` with the submit button disabled. An
  author should never spend a request on a rule the field already displays. Page
  descriptions are optional and capped only, so the `maxLength` alone enforces their
  bound and the pane prints no counter.
- A collection's `name` and `description` are edited from the **panel**, in the
  same dialog that created it. Two consequences follow: the header's only
  destructive action is the collection's own `Delete` (gated on `canDelete`),
  because node deletes belong to the rows they name and the panel list keeps
  destructive actions out of its rows; and an editor that is already open keeps
  showing the old name in its header until its next write refreshes the tree.
  Nothing syncs that, and nothing needs to. Renaming is still the dangerous
  corner — `name` is the string agents pass as `list_kb_pages(kb_name)`, so a
  rename silently breaks the phrasing an existing conversation already used; the
  write edge enforces the slug rule and the dialog states it on failure.
- Group depth is capped at 2, with the cap stated rather than silently enforced —
  a hidden ceiling just looks like a bug. The group dialog offers only **Top
  level** and the level-1 groups. A new group starts at level 1, since no group is
  ever in view to inherit a parent from; moving one down is a deliberate choice in
  the Parent select. A group that already owns children is pinned to level 1 — the
  dialog states that instead of offering a parent the server would refuse.
- Pages with no group are listed last, as plain rows with no heading and no
  tally. A bucket label would be a group name the server refuses, folds nothing,
  and renames nothing; the agent surface spells the same set `ungroupedPages`
  (§4.2), and the only place the positive label **Top level** survives is the
  Group / Parent select in the two dialogs, where picking it is the write that
  unsets the link.
- Deleting states its own consequence rather than querying for it: the confirm
  body names the page count (already in the row) and that the bindings agents
  hold are removed with it, because `builtin_agent_tool.kb_collection_id` is
  `onDelete: "cascade"`. No per-row reverse lookup, no extra query at delete time.
  A row's trash describes **the row**, not whatever happens to be selected: the
  confirm looks the node up by id, and the pane is reset when the open page is
  among the rows actually lost. Deleting a group deletes its pages with it
  (§3.6), so its confirm says so — "Its 4 pages are deleted with it. This cannot
  be undone." — and the editor drops every body cached under that group, not just
  the one it happens to be showing. A group with nested groups stays refused, and
  its confirm states the refusal it will get rather than pretending the delete
  will go through.
- Permission gating is the same hook as everywhere else (`useResourcePermissions`),
  and a denied action renders a static `<span>` where the button would be, or
  nothing at all where the action has no read-only meaning — never a disabled
  button. The **panel** gates the enabled / visibility toggles on
  `canChangeVisibility` (author or admin) and the metadata pencil on `canEdit`,
  which is simply absent for someone who cannot rename. Any collection the editor
  can load is already editable by whoever loaded it — the page reads through
  `loadVisibleCollection`, and `canEdit` is true for own, public-plus-editor, or
  admin — so in the **editor** `canEdit` decides nothing new beyond the fields'
  `readOnly` and which buttons appear: it is the single `editable` flag the tree
  reads, and it removes the two create actions and every row's pencil and trash
  together, because a viewer who cannot write should not be shown controls that
  only open a dialog to fail. `canDelete` alone gates the collection Delete. The
  hook settles a beat after mount, so the header's action cluster appears when it
  resolves rather than flashing "Read-only" at an author who can edit.
- The center pane does **not** wire `useCopilotDraft`: that mechanism exists so an
  agent can rewrite a resource, and agents cannot write knowledge (§1.1).

No endpoint or schema change is required to build this: `GET /api/kb` ships
`topLevelGroupCount` / `pageCount`, and the tree comes from `GET /api/kb/[id]`.

---

## 9. Build order

Each step is independently reviewable and lands with its own migration or
none.

1. **Schema**: `kb_collection`, `kb_group`, `kb_page`, **plus** the
   `kb_collection_id` column, its reverse-lookup index, the `"knowledge"`
   member of `AgentToolType`, and the junction's `tool_type` comment — the FK
   target and its referencing column must land in one migration, so this is
   not deferrable to step 2. Migration itself: `pnpm db:generate
   --name=kb_tables` producing the SQL and `meta/` snapshot together, then
   `pnpm db:migrate`.
2. **Junction decode + spec**: `toolType = "knowledge"` handled in
   `AgentToolRef` (`{ kind: "knowledge"; kbCollectionId: string }`) and spec
   decoding — which, because `mapToolRow` has an exhaustiveness contract, also
   pulls in the two `boundToolSchema` enums and insert mappings in
   `src/app/api/builtin-agents/route.ts` and `[id]/route.ts`, the GET projection,
   and `BoundToolRow`. Without them a binding could be decoded but never saved.
3. **Limits + config**: `src/lib/kb/limits.ts` holding `MAX_DESCRIPTION_CHARS`,
   `MIN_DESCRIPTION_CHARS` and `MAX_LABEL_CHARS` (code constants); the four
   `kb.*` entries in `src/lib/config/defaults.ts`.
4. **Service + API**: CRUD under `src/lib/kb/`, all §6 budgets and the §2.2
   ordering as typed errors, `withEditor` / `withAdmin` wrapping. No cache
   invalidation — see §4.4.
5. **Runtime tools**: the ssh-shaped trio under `src/lib/kb/` — `lookup.ts`
   (agent-side reads, no RBAC: binding is the grant), `prompt-block.server.ts`
   (`buildKbPromptBlock(collectionIds) → { promptBlock }`), and
   `runtime-tools.ts` (`buildListKbPagesTool` / `buildReadKbPageTool`) exposing
   `list_kb_pages(kb_name, group_name?)` and
   `read_kb_page(kb_name, page_name, offset?, limit?)`. There is deliberately
   no `buildKbRuntime` wrapper: two unconditional tools and one block do not
   need the fan-in layer `buildSkillsRuntime` exists to give four
   conditionally-mounted tools. Dispatch wiring at
   `src/lib/runner/dispatch/builtin.ts` (kind branch, prompt-block call, tool
   construction beside `sshTools`, the `APPROVAL_EXEMPT_TOOLS` set) plus a
   low/`read`/`readOnlyHint` entry for each tool in `BUILTIN_TOOL_RISK_MAP`
   (`src/lib/agent-pipeline/risk-registry.ts`) — without that entry an
   unannotated tool defaults to `medium` / `write`, which is wrong for a read
   and fails `require`/`annotation` default policies.
6. **Prompts**: `## Available knowledge` block + `docs/prompts.md` rows +
   composition slot (after Calendar, before Chart).
7. **UI**: KB panel and editor; replace the `"knowledge"` Tab placeholder with
   the real picker, and delete the unused `kbEnabled` form field.
8. **Docs + guard**: update `docs/architecture.md` table overview,
   `AGENTS.md` architecture rules (new numbered item), then
   `pnpm check-types && pnpm lint && pnpm comments:check:all`.
9. **Optional**: "Save as knowledge page" from outcomes.

---

## 10. Open questions

Deferred with reasons, so they read as decisions rather than omissions.

- **Versioning / history for pages.** `updated_by` / `updated_at` are enough
  until someone actually needs to diff a knowledge page. Deletion is hard
  (§3.6): a tombstone on these three tables would have to be filtered by every
  read path, including the mount block. A history table is cheap to add later
  and expensive to keep in sync now.
- **Redaction on `visibility: 'public'`.** A KB holding system config notes is
  a different sensitivity class from a product manual. Nothing in the current
  schema forces a secret-scan; if public KBs start carrying credentials,
  that needs a policy check on write, not on read.
- **Cross-collection search.** Rejected for now: it would reintroduce a
  retrieval mechanism the mounting discipline exists to avoid. If misses
  cluster on "wrong KB chosen", the fix is sharper `collection.description`
  text, which is the level-1 routing signal.
- **Search over page text.** Also rejected as a Phase-1 item. Postgres
  `tsvector` works without an embedding model, but Chinese content needs a
  tokenizer extension (`zhparser` / `pg_jieba`) — a new deployment dependency
  bought before any measured miss justifies it. Revisit from §7.1 miss data;
  if it returns, the `read_kb_page`/`list_kb_pages` tool names stay stable and the
  search implementation swaps underneath.
- **Vector recall (pgvector).** Rejected outright. Condensed pages plus
  navigation is the retrieval mechanism; embeddings would be a second
  artifact doing the same job, less explainably, with a per-write embedding
  call and a full re-embed whenever the embedding model changes.
- **Scale.** All budgets in §6 assume a personal / small-team KB on one Node
  process. That matches the project's runtime boundary (`docs/architecture.md`
  §"Runtime boundary"); there is no multi-instance story here, and a
  filesystem-storage abstraction is unnecessary because the filesystem is not
  in the design.
