# Artifact + Dashboard Library — Design & Migration

> Status: M1 landed; M2 in progress
> Audience: engineers implementing this milestone series; reviewers
> Related: `docs/data-visualization.md` §6 (the outcome → artifact save
> flow that lands here), `docs/persisted-agent-runner-migration.md`
> (structural precedent for this doc)

## 1. Background

Chat-time chart generation already works end-to-end: the agent calls
`render_chart`, the frontend handler stores the result in
`outcomeStore`, the user sees a card in the main panel, and clicking
"Save" persists one row into `artifact`. But the artifact library
itself is a placeholder — there is no left-panel browser, no
grouping, no way to organize, and no way to compose multiple
artifacts into a presentable dashboard.

The product vision is a four-layer pipeline:

```
chat ────────────────► outcome ─────────► artifact ─────────► dashboard
(ephemeral SSE)      (per-thread       (saved library,      (composition
                      preview)          atomic blocks)       + URL +
                                                            publish)
```

Each layer has a single, narrow purpose; concepts flow one direction
and never leak backwards. This doc nails down the second-half schema
(artifact + dashboard) and the migration that gets us there. It
folds together the discussion captured in
`docs/persisted-agent-runner-migration.md`-style commit conversations
held over the previous design sessions.

## 2. Decisions (all locked)

| # | Decision | Note |
|---|---|---|
| 1 | **Artifact tree**: single table `artifact`, self-referencing `parent_id`. | Categories are real rows at `parent_id IS NULL`; system-seeded per user. |
| 2 | **Artifact `kind` discriminator**: `"folder" \| "artifact"`. | Two values only. No separate `"category"` kind — categories are folders at top level, distinguished implicitly by `parent_id IS NULL`. |
| 3 | **System categories**: per-user seed at registration. **Immutable** — cannot rename, cannot delete, cannot reparent. | Type-locked: each seed maps 1:1 to an `ArtifactType` value (`"echart" → "Charts"`, `"html" → "HTML"`, ...). |
| 4 | **Artifact tree depth**: unlimited under a category. UI hints at flat usage. | DB has no depth constraint. |
| 5 | **Dashboard tree**: single table `dashboard`, self-referencing `parent_id`, `kind ∈ {"folder", "dashboard"}`. Arbitrary depth, no top-level seed. | Structurally similar to artifact tree but without system categories — dashboards are uniform leaves. |
| 6 | **Dashboard ↔ Artifact**: many-to-many reference. | `dashboard_artifact` association row holds grid position. Same artifact may appear multiple times in the same dashboard (allowed). |
| 7 | **Dashboard URL**: slug-based, `/d/<slug>`. Slug globally unique. | Reparenting in tree does NOT change URL. Renaming does NOT change slug. Slug is user-editable (with conflict check). |
| 8 | **Publish semantics**: same-tenant read-only. | Any authenticated user can view a published dashboard. Anonymous cannot. Owner can edit, edits propagate to public view on save. No snapshot, no draft state in V1. |
| 9 | **Grid editor**: `react-grid-layout`. | Drag in artifacts, drag-resize tiles, layout persisted as JSON in `dashboard.layout`. |
| 10 | **Folder delete**: blocked if non-empty. | User must explicitly empty before deletion. No trash bin in V1. |
| 11 | **Artifact delete**: blocked if referenced by any dashboard. | `ON DELETE RESTRICT` on `dashboard_artifact.artifact_id`. |
| 12 | **`outcome.groupId` field**: dropped. | Outcomes no longer have a grouping concept; grouping happens in the artifact library. |
| 13 | **`menu_item` table**: dropped. | Originally generic nav tree; no longer needed since artifact and dashboard each have their own self-referencing tree. |

## 3. Architecture overview

### 3.1 Concept layers

| Layer | Lives in | Lifetime | Has tree? |
|---|---|---|---|
| **Event** | `entity_run_event` (Postgres) | Forever (per run) | No — flat per-run sequence |
| **Outcome** | `outcomeStore` (Zustand, client-only) | Per-thread; cleared on thread switch; rebuilt on replay | No — flat per-thread list |
| **Artifact** | `artifact` (Postgres) | Forever (until user deletes) | Yes — self-FK tree, depth-unlimited under system categories |
| **Dashboard** | `dashboard` (Postgres) | Forever | Yes — self-FK tree, depth-unlimited, no top-level seed |

### 3.2 User-facing flow

```
chat              outcome panel              artifact library      dashboard library
─────             ─────────────              ────────────────      ─────────────────

[render_chart] → [chart card] ─Save→ [Save dialog] → [artifact in tree]
                                       │
                                       └─ pick group / new group
                                                                   ┌──────────────────┐
                                                                   │ + New dashboard │
                                                                   └──────────────────┘
                                                                           │
                                                                           ▼
                                                                   ┌──────────────────┐
                                                                   │ Grid editor      │
                                                                   │ drag artifacts → │
                                                                   │ resize / arrange │
                                                                   │                  │
                                                                   │ ▷ Publish        │
                                                                   └──────────────────┘
                                                                           │
                                                                           ▼
                                                                   /d/<slug>  ← any
                                                                              tenant user
```

### 3.3 Atomicity & reference semantics

- An **artifact row is the source of truth** for its content. A
  dashboard tile is just `(dashboard_id, artifact_id, grid_x, grid_y,
  grid_w, grid_h)`. Editing the artifact's content (e.g. tweaking the
  ECharts option) immediately reflects in every dashboard that
  references it.
- A **dashboard's `layout` JSON** is a cached projection of its
  `dashboard_artifact` rows — keeping it on the dashboard row itself
  avoids a join for read-only viewers. The association table is the
  authoritative store; `layout` is rebuilt on save.

## 4. Schema

### 4.1 New: `artifact` (replaces existing `ArtifactTable`)

```ts
artifact {
  id              uuid PRIMARY KEY
  parent_id       uuid  REFERENCES artifact(id) ON DELETE RESTRICT, nullable
  kind            text  NOT NULL CHECK (kind IN ('folder', 'artifact'))
  type            text  nullable                        -- ArtifactType values; only when kind = 'artifact'
  name            text  NOT NULL
  description     text  nullable
  content         jsonb nullable                        -- ECharts option / HTML / etc.; only when kind = 'artifact'
  config          jsonb nullable                        -- render config (carry-over from old schema)
  source_thread_id  text nullable
  source_outcome_id text nullable
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared'))
  display_order   int  NOT NULL DEFAULT 0
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
  created_at      timestamp NOT NULL DEFAULT now()
  updated_at      timestamp NOT NULL DEFAULT now()
}

UNIQUE INDEX artifact_unique_name_per_parent (created_by, parent_id, name)
                                              -- treats parent_id NULL as a distinct bucket
INDEX artifact_parent_idx (parent_id)
INDEX artifact_created_by_idx (created_by)
INDEX artifact_type_idx (type) WHERE kind = 'artifact'
INDEX artifact_source_idx (source_thread_id, source_outcome_id) WHERE source_thread_id IS NOT NULL
```

#### 4.1.1 Application-layer invariants

These are NOT enforced by DB but by the service layer + API route:

- `parent_id IS NULL` ⇒ row is a system-seeded category folder.
  - Only the user-creation hook may INSERT such rows.
  - User-facing endpoints REJECT `INSERT` / `UPDATE` / `DELETE` on
    rows with `parent_id IS NULL`.
- `kind = 'artifact'` ⇒ `parent_id IS NOT NULL` AND `type IS NOT NULL`
  AND `content IS NOT NULL`. API rejects otherwise.
- `kind = 'folder'` ⇒ `type IS NULL` AND `content IS NULL`. API
  rejects otherwise (defensive: clients should not send these fields
  for folder rows).
- A folder cannot be deleted if it has any children. API rejects
  with `409 Conflict`.

> Why not `CHECK` constraints? Drizzle's check-constraint support
> across migrations is fragile; we prefer service-layer enforcement
> consolidated in one helper (`validateArtifactRow`). Constraints
> may be added in a later migration once the invariants stabilise.

#### 4.1.2 Per-user category seed

When a user is created (via better-auth `databaseHooks.user.create.after`),
the server inserts one folder row per known `ArtifactType` value:

| Seed `name` | Maps to type | Notes |
|---|---|---|
| "Charts" | `echart`, `chart` | Two types under one category — chart is the legacy display name; new artifacts use `echart` |
| "Reports" | `report` | |
| "Code" | `code` | |
| "Dashboards" | `dashboard` | Note: this is the artifact type, separate from the standalone `dashboard` table |
| "Images" | `image` | |
| "HTML" | `html` | |
| "PPT" | `ppt` | |

All seed rows have `parent_id = NULL`, `kind = "folder"`, `type =
NULL`, `created_by = <new user id>`. Each user has exactly one of
each (no duplicates). Seed list is fixed by a constant in
`src/lib/domain/artifact.ts`; adding a new type requires a code
change AND a migration that backfills existing users.

### 4.2 New: `dashboard`

```ts
dashboard {
  id              uuid PRIMARY KEY
  parent_id       uuid REFERENCES dashboard(id) ON DELETE RESTRICT, nullable
  kind            text NOT NULL CHECK (kind IN ('folder', 'dashboard'))
  name            text NOT NULL
  description     text nullable
  slug            text nullable                          -- only when kind = 'dashboard'; globally unique
  layout          jsonb nullable                         -- only when kind = 'dashboard'
  published_at    timestamp nullable                     -- null = unpublished
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared'))
  display_order   int  NOT NULL DEFAULT 0
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
  created_at      timestamp NOT NULL DEFAULT now()
  updated_at      timestamp NOT NULL DEFAULT now()
}

UNIQUE INDEX dashboard_slug_unique (slug) WHERE slug IS NOT NULL
UNIQUE INDEX dashboard_unique_name_per_parent (created_by, parent_id, name)
INDEX dashboard_parent_idx (parent_id)
INDEX dashboard_created_by_idx (created_by)
INDEX dashboard_published_idx (published_at) WHERE published_at IS NOT NULL
```

Invariants (service-layer):
- `kind = 'dashboard'` ⇒ `slug IS NOT NULL` AND `layout IS NOT NULL`.
- `kind = 'folder'` ⇒ `slug IS NULL` AND `layout IS NULL`.
- A folder cannot be deleted if non-empty.
- `slug` must match `^[a-z0-9][a-z0-9-]{0,62}$`. Auto-generated from
  `name` on dashboard creation; user-editable.
- Folder rows cannot be published (no slug, no URL).

### 4.3 New: `dashboard_artifact` (M2M + grid layout)

```ts
dashboard_artifact {
  id              uuid PRIMARY KEY                       -- surrogate; allows same artifact to appear multiple times
  dashboard_id    uuid NOT NULL REFERENCES dashboard(id) ON DELETE CASCADE
  artifact_id     uuid NOT NULL REFERENCES artifact(id) ON DELETE RESTRICT
  grid_x          int  NOT NULL
  grid_y          int  NOT NULL
  grid_w          int  NOT NULL
  grid_h          int  NOT NULL
  display_order   int  NOT NULL DEFAULT 0
  created_at      timestamp NOT NULL DEFAULT now()
}

INDEX dashboard_artifact_dashboard_idx (dashboard_id)
INDEX dashboard_artifact_artifact_idx (artifact_id)       -- for "where is this artifact referenced?"
```

Invariants:
- `artifact_id` must reference a row with `kind = 'artifact'` (not a
  folder). Service-layer check.
- Deleting a `dashboard` cascades the rows here (the dashboard owns
  its layout).
- Deleting an `artifact` is RESTRICTED while any rows here reference
  it. Service-layer error message: "Cannot delete artifact 'X' —
  used by N dashboards. Remove it from those dashboards first."

### 4.4 Dropped

- `menu_item` table — all of it.
- `artifact.menu_item_id` column — replaced by `artifact.parent_id`.
- `outcome.groupId` field on `ChartOutcome` (TypeScript-only; not a
  DB column).

### 4.5 Existing `artifact` schema diff

```diff
  artifact {
    id              uuid PRIMARY KEY
+   parent_id       uuid REFERENCES artifact(id) ON DELETE RESTRICT
+   kind            text NOT NULL
-   type            text NOT NULL
+   type            text                                  -- nullable now
    name            text NOT NULL
    description     text
+   content         jsonb                                 -- was NOT NULL
-   content         jsonb NOT NULL
    config          jsonb
-   menu_item_id    bigint REFERENCES menu_item(id)
+   display_order   int NOT NULL DEFAULT 0
    visibility      text NOT NULL DEFAULT 'private'
    source_thread_id  text
    source_outcome_id text
    created_by      uuid NOT NULL
    created_at      timestamp NOT NULL
    updated_at      timestamp NOT NULL
  }
```

## 5. Migration plan

### 5.1 Drizzle migration (single migration file, e.g. `0032_artifact_dashboard_redesign.sql`)

Generated via `pnpm drizzle-kit generate` after editing `schema.ts`,
then hand-checked. The SQL roughly:

```sql
BEGIN;

-- 1. New columns on artifact
ALTER TABLE artifact ADD COLUMN parent_id uuid REFERENCES artifact(id) ON DELETE RESTRICT;
ALTER TABLE artifact ADD COLUMN kind text NOT NULL DEFAULT 'artifact';
ALTER TABLE artifact ADD COLUMN display_order int NOT NULL DEFAULT 0;
ALTER TABLE artifact ALTER COLUMN type DROP NOT NULL;
ALTER TABLE artifact ALTER COLUMN content DROP NOT NULL;

-- 2. Drop legacy menu_item FK + table
ALTER TABLE artifact DROP COLUMN menu_item_id;
DROP TABLE menu_item;

-- 3. Seed system categories for existing users (per-user, idempotent)
INSERT INTO artifact (id, parent_id, kind, type, name, content, visibility, created_by, created_at, updated_at)
SELECT gen_random_uuid(), NULL, 'folder', NULL, cat.name, NULL, 'private', u.id, now(), now()
FROM users u
CROSS JOIN (
  VALUES
    ('Charts'),
    ('Reports'),
    ('Code'),
    ('Dashboards'),
    ('Images'),
    ('HTML'),
    ('PPT')
) AS cat(name)
WHERE NOT EXISTS (
  SELECT 1 FROM artifact a
  WHERE a.created_by = u.id AND a.parent_id IS NULL AND a.name = cat.name
);

-- 4. Backfill parent_id for existing artifact rows
--    Map each row's type → its owner's matching category folder.
UPDATE artifact a
SET parent_id = (
  SELECT cat.id FROM artifact cat
  WHERE cat.created_by = a.created_by
    AND cat.parent_id IS NULL
    AND cat.name = CASE a.type
      WHEN 'chart'     THEN 'Charts'
      WHEN 'echart'    THEN 'Charts'
      WHEN 'report'    THEN 'Reports'
      WHEN 'code'      THEN 'Code'
      WHEN 'dashboard' THEN 'Dashboards'
      WHEN 'image'     THEN 'Images'
      WHEN 'html'      THEN 'HTML'
      WHEN 'ppt'       THEN 'PPT'
    END
)
WHERE a.kind = 'artifact' AND a.parent_id IS NULL;

-- 5. Drop the default we set on kind (it was only there to satisfy
--    NOT NULL during the bulk update). Future inserts must specify.
ALTER TABLE artifact ALTER COLUMN kind DROP DEFAULT;

-- 6. Add unique + standard indexes
CREATE UNIQUE INDEX artifact_unique_name_per_parent
  ON artifact (created_by, COALESCE(parent_id::text, ''), name);
CREATE INDEX artifact_parent_idx ON artifact (parent_id);
CREATE INDEX artifact_type_idx ON artifact (type) WHERE kind = 'artifact';
-- (created_by, source_thread_id, source_outcome_id indexes already exist
-- from the original ArtifactTable schema)

-- 7. New tables: dashboard + dashboard_artifact
CREATE TABLE dashboard (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       uuid REFERENCES dashboard(id) ON DELETE RESTRICT,
  kind            text NOT NULL,
  name            text NOT NULL,
  description     text,
  slug            text,
  layout          jsonb,
  published_at    timestamp,
  visibility      text NOT NULL DEFAULT 'private',
  display_order   int  NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dashboard_slug_unique ON dashboard (slug) WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX dashboard_unique_name_per_parent
  ON dashboard (created_by, COALESCE(parent_id::text, ''), name);
CREATE INDEX dashboard_parent_idx ON dashboard (parent_id);
CREATE INDEX dashboard_created_by_idx ON dashboard (created_by);
CREATE INDEX dashboard_published_idx ON dashboard (published_at) WHERE published_at IS NOT NULL;

CREATE TABLE dashboard_artifact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id    uuid NOT NULL REFERENCES dashboard(id) ON DELETE CASCADE,
  artifact_id     uuid NOT NULL REFERENCES artifact(id) ON DELETE RESTRICT,
  grid_x          int  NOT NULL,
  grid_y          int  NOT NULL,
  grid_w          int  NOT NULL,
  grid_h          int  NOT NULL,
  display_order   int  NOT NULL DEFAULT 0,
  created_at      timestamp NOT NULL DEFAULT now()
);
CREATE INDEX dashboard_artifact_dashboard_idx ON dashboard_artifact (dashboard_id);
CREATE INDEX dashboard_artifact_artifact_idx ON dashboard_artifact (artifact_id);

COMMIT;
```

Notes:
- Steps 3-4 are idempotent — re-running the migration in dev is safe.
- The COALESCE-in-unique-index trick is needed because Postgres
  treats NULL as distinct in unique constraints by default; we want
  "two rows under the same NULL parent with the same name" to
  conflict.
- Migration is **forward-only**. No down migration. If a rollback
  becomes necessary we hand-craft it from the state at that point.

### 5.2 Pre-launch posture

Project hasn't launched. We accept that the migration touches existing
artifact rows in dev DBs but **doesn't preserve any folder
organization** — old `menu_item.parent_id` chains are not migrated to
new `artifact.parent_id` folders. Reasons:
- The `menu_item` tree was never exposed in UI; no user has used it.
- Each existing artifact lands under its type-matched system category,
  ungrouped.
- If anyone has populated `menu_item` rows for tests, those rows are
  lost on `DROP TABLE`. Document this in the migration commit.

### 5.3 Client-side changes (M1)

- `src/store/outcome-store.ts`: remove `groupId: string | null` from
  `BaseOutcome`. All references to it (handler, comparators, tests).
- `/api/threads/[threadId]/outcomes` route: stops returning
  `groupId`. Updates the response schema accordingly.

### 5.4 better-auth user-creation hook

`src/lib/auth/auth-instance.ts` already uses
`databaseHooks.user.create.before` (for role assignment). Add an
`after` hook that calls `seedArtifactCategoriesForUser(user.id)`. The
seed function lives in `src/lib/artifacts/seed.ts` and is also
exposed for the migration script's idempotent backfill.

## 6. API surface (M1 ships these)

### 6.1 `POST /api/artifacts`

Two flavours, picked by `body.kind`:

**Folder create** — `{ kind: "folder", parent_id, name, description? }`:
- Requires `parent_id` (cannot create top-level folder via API).
- Validates parent ownership (must belong to session user).
- Validates parent.kind = "folder".
- Validates parent.parent_id != null OR parent is a system category
  (i.e. can create folder anywhere except as a sibling of system
  categories at level 0).
- Returns `201 { id }`.

**Artifact create** — `{ kind: "artifact", parent_id, type, name, description?, content, config?, source_thread_id?, source_outcome_id?, visibility? }`:
- Requires all of `parent_id`, `type`, `name`, `content`.
- Validates `type ∈ ARTIFACT_TYPES`.
- Validates parent is a folder owned by session user (parent itself
  may be a system category or a user folder).
- Idempotency: if `source_thread_id + source_outcome_id` already exist
  for this user, return existing `{ id, alreadySaved: true }`.
- Returns `201 { id, alreadySaved: false }`.

### 6.2 `GET /api/artifacts/tree`

Returns the full artifact tree for the session user:
```json
{
  "roots": [
    {
      "id": "...", "kind": "folder", "name": "Charts", "system": true,
      "children": [
        { "id": "...", "kind": "folder", "name": "Sales Q1", "children": [...] },
        { "id": "...", "kind": "artifact", "type": "echart", "name": "...", "savedFromOutcome": "..." }
      ]
    },
    ...
  ]
}
```

- Tree is fetched in one query (recursive CTE) and assembled
  server-side; client receives nested JSON.
- `system: true` marker on category folders so the client can
  disable edit/delete affordance.
- Leaf `artifact` nodes do NOT include `content` (it can be large);
  client fetches `GET /api/artifacts/[id]` on demand.

### 6.3 `GET /api/artifacts/[id]`

Returns one row. If folder, includes children IDs only. If artifact,
includes `content`.

### 6.4 `PATCH /api/artifacts/[id]`

- Folder: can update `name`, `description`, `parent_id`,
  `display_order`. Cannot touch `kind`, `type`, `content`.
- Artifact: can update `name`, `description`, `parent_id`, `content`,
  `config`, `display_order`. Cannot touch `kind`, `type`,
  `source_thread_id`, `source_outcome_id` (those are creation-only
  audit fields).
- System category folders (parent_id IS NULL): all updates rejected
  with `403`.

### 6.5 `DELETE /api/artifacts/[id]`

- System category: `403`.
- Folder with children: `409 Conflict` — "folder not empty".
- Artifact referenced by any dashboard: `409 Conflict` — "in use".
- Otherwise: `204`.

### 6.6 Dashboard endpoints — deferred to M3

M1 does not ship dashboard CRUD. The tables exist (so migration is
one-shot) but only seed data and structure. M3 fills in routes.

## 7. Test plan (M1)

### 7.1 Unit

- `seedArtifactCategoriesForUser` — inserts exactly N rows, idempotent.
- `validateArtifactRow` — accepts valid folder/artifact shapes,
  rejects every documented invariant violation.
- `assembleTree` — given a flat row list, builds the nested response
  structure deterministically (sort by `display_order` then
  `created_at`).

### 7.2 Integration / route handler

- `POST /api/artifacts` folder create — happy path + parent_id null
  rejection + parent ownership rejection.
- `POST /api/artifacts` artifact create — happy path + idempotency
  via `source_thread_id+source_outcome_id` + missing `content`
  rejection.
- `GET /api/artifacts/tree` — N user → only their tree returned
  (cross-user leakage test).
- `DELETE /api/artifacts/[id]` — system category rejection,
  non-empty folder rejection, in-use artifact rejection.

### 7.3 Migration

- Run migration against a snapshot of dev DB. Assert:
  - Every existing `artifact` row gets a non-null `parent_id` matching
    its type's category folder.
  - Every existing user has exactly N category folder rows.
  - `menu_item` table no longer exists.

## 8. Implementation steps (M1)

Roughly 12 ordered steps. Each is a single PR-able unit:

1. **Define new constants**: `src/lib/domain/artifact.ts` adds
   `SEED_CATEGORIES` (name + matching types) + `ARTIFACT_KIND`.
2. **Schema edit**: `src/lib/db/schema.ts` — modify `ArtifactTable`
   (new columns, drop FK), drop `MenuItemTable`, add `DashboardTable`
   + `DashboardArtifactTable`.
3. **Generate migration**: `pnpm drizzle-kit generate` (or hand-write)
   producing `0032_artifact_dashboard_redesign.sql`. Hand-review +
   adjust for the seed and backfill blocks shown in §5.1.
4. **Service module**: `src/lib/artifacts/service.ts` —
   `seedArtifactCategoriesForUser`, `validateArtifactRow`,
   `assembleTree`, plus helpers for folder/artifact CRUD with
   invariant checks. All DB calls live here, no DB in route handlers.
5. **Wire seed into user creation**: extend
   `databaseHooks.user.create` in `src/lib/auth/auth-instance.ts`
   with an `after` callback that calls
   `seedArtifactCategoriesForUser`.
6. **Rewrite `POST /api/artifacts`** to handle `kind` discriminator
   and delegate to the service. Preserve the existing idempotency
   contract for `source_thread_id+source_outcome_id`.
7. **New routes**: `GET /api/artifacts/tree`,
   `GET/PATCH/DELETE /api/artifacts/[id]`.
8. **Client store cleanup**: drop `groupId` from `ChartOutcome`,
   remove from `addOutcome` payloads in `useOutcomeTools`, fix tests.
9. **Outcomes replay route**: stop including `groupId` in
   `/api/threads/[threadId]/outcomes` response.
10. **Unit + integration tests** for §7.
11. **Manual smoke**: run dev server, log in as a fresh user, generate
    a chart, click Save (existing button — UI dialog comes in M2),
    confirm DB has the row under the correct category folder. Hit
    `GET /api/artifacts/tree`, eyeball JSON.
12. **Commit + doc update**: this file's §13 "Final state" gets the
    M1 commit ledger.

## 9. Risks & open items

### Risks

- **Drizzle's NULL-in-unique-index handling**: the `COALESCE` trick
  is Postgres-specific; if we ever switch DB we lose name uniqueness
  enforcement at the folder root level. Mitigation: service-layer
  also checks before insert.
- **Seed timing**: if `databaseHooks.user.create.after` does not exist
  in our better-auth version, fall back to a lazy approach — on first
  call to `GET /api/artifacts/tree`, check whether the user has any
  category folders, seed if missing. Less elegant but bulletproof.
- **Existing artifact rows without a matching type→category map**:
  e.g. some old row has `type = 'pivot'` which is not in the seed
  list. Migration places it under no folder (NULL parent_id post-update)
  → service-layer would reject it. Mitigation: the migration aborts
  if any row has an unmapped type; surface the count + types so the
  fix is a single ALTER (extend the seed list, re-run).

### Open items for later milestones

- **M2** ships the Save dialog + Artifacts left panel tree. UI design
  to be drafted at M2 start.
- **M3** ships Dashboard CRUD + left panel tree (mirror of M2 patterns).
- **M4** ships the grid editor (`react-grid-layout` integration).
- **M5** ships publish + public viewer route `/d/<slug>`.
- **Slug auto-generation strategy** for Chinese names — pinyin? UUID
  short code? Manual entry mandatory? — decided at M5 design time.
- **Edit history** for artifacts and dashboards — not in any of
  M1-M5. Possibly added later if users ask for it.
- **Cross-user sharing** beyond "publish" (e.g. invite specific
  users to a private dashboard) — not in V1.

## 10. Final state (post-M1)

| Commit | Scope |
|---|---|
| _this commit_ | Steps 1-9 — domain constants, schema, migration 0032, service layer, auth seed hook, POST kind-discriminator, GET tree + [id] PATCH/DELETE, drop client `groupId` |

Smoke verified (Step 11):

- migration apply on dev DB drops `menu_item`, adds `parent_id` /
  `kind` / `display_order` to `artifact`, creates `dashboard` +
  `dashboard_artifact`, seeds 6 root categories per user, backfills
  existing `artifact.parent_id` from the legacy `type` value.
- `GET /api/artifacts/tree` returns the seeded categories with the
  pre-existing chart rows nested under Charts.
- `POST /api/artifacts {kind:"artifact", type:"chart"}` lands the
  new row under the user's Charts folder without an explicit
  `parentId`.
- `POST /api/artifacts` is idempotent on
  `(sourceThreadId, sourceOutcomeId)`: second call returns the same
  id with `alreadySaved=true`.
- `POST /api/artifacts {kind:"folder", parentId}` creates a
  sub-folder.
- `DELETE /api/artifacts/<seed-category>` is rejected with 403
  (`FORBIDDEN — System categories cannot be modified or deleted`).
- `DELETE /api/artifacts/<non-empty-folder>` is rejected with 409
  (`CONFLICT — Folder is not empty`).
- `PATCH /api/artifacts/<id> {parentId: <self>}` is rejected with
  400; `{parentId: null}` likewise.
- `PATCH /api/artifacts/<non-existent>` returns 404.

Step 10 — vitest coverage at `tests/unit/lib/artifacts/service.test.ts`:
the suite exercises `assembleTree` shape + orphan filtering,
`seedArtifactCategoriesForUser` idempotency, `updateNode`
seed/cycle/root-move rejections, `deleteNode` seed + non-empty
checks, and `createFolder` parent validation. Route-level coverage
intentionally deferred — the wrappers are thin, the §11 smoke
ledger already exercises them end-to-end.

> Historical note: the original M2 design also shipped a
> `createArtifact` service function with server-side category
> auto-routing + missing-seed self-heal. Both were retired with the
> M2 save flow consolidation (W1.7.7); `saveArtifact` requires the
> caller to pre-resolve `parentId` via the save dialog, and the
> seed-failure recovery path is no longer wired (see comment in
> `auth-instance.ts`).

## 11. M2 design — Save dialog, library panel, detail page

> Status: design locked; implementation in progress.

### 11.1 Scope (locked)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Save = always a dialog**, never silent. | User wants control over name + destination on every save. Idempotency on `(sourceThreadId, sourceOutcomeId)` is enforced server-side, so the dialog only opens when `outcome.savedArtifactId` is `null`. |
| 2 | **Leaf click in the panel → opens `/artifact/[id]` in the main area.** | Detail page is part of M2 scope. Hover/popover preview rejected — too much UI surface for a sidebar. |
| 3 | **Folder ops live in a hover-revealed three-dot menu on the row.** | Right-click ruled out (non-discoverable on web). A panel-level toolbar acting on a "current selection" rejected (extra mode). The dropdown opens on click of the `⋯` icon. Seed categories show the same `⋯` button but only the `New sub-folder` entry — `Rename` / `Delete` are absent because the service rejects them. |
| 4 | **Detail page (`/artifact/[id]`) is in M2.** | Renders the chart, the metadata (parent path, type, source thread/outcome, dates), and exposes inline `Rename` / `Move to…` / `Delete` actions. |

### 11.2 Components

- `hooks/useArtifactTree.ts` — SWR-backed reader for `GET /api/artifacts/tree`. Single source of truth for both the left panel and the folder-picker dialogs. `mutate()` after every write so the tree stays consistent without manual refresh.
- `components/library/ArtifactFolderTreeSelect.tsx` — shared folder picker. Renders the tree (folders only — leaves are hidden), supports expand/collapse, selects a single folder id. Disables top-level-root selection unless `allowRoot=false` (always `false` in M2).
- `components/library/SaveOutcomeDialog.tsx` — opened from `OutcomeCard`'s Save button. Fields: `name` (default = `outcome.title`), `folder` (default = the seed category for `outcome.kind`), `description` (optional). Submit calls `POST /api/artifacts` with `kind:"artifact"` + the chosen `parentId`. The button on the card stays a `Save` icon until the post succeeds; the green ✓ check appears afterwards (existing logic, unchanged).
- `components/left-panels/ArtifactPanel.tsx` — rewritten. Tree view, search filter, "+ New folder under root-…" disabled because the root level is system-managed, "+ Refresh" calls `mutate()`. Hover row → `⋯` button with `New sub-folder` / `Rename` / `Delete` (leaves: `Rename` / `Delete`, no New sub-folder). Each leaf row clicks through to `/artifact/<id>`.
- `app/(workspace)/artifact/[id]/page.tsx` — detail page. Server component fetches the artifact, asserts ownership, renders metadata + the live chart via `EChartsRenderer`. Inline actions (`Rename`, `Move to`, `Delete`) are client components powered by the shared dialogs / PATCH / DELETE calls.

### 11.3 API additions

None required. `GET /api/artifacts/[id]` currently returns the row only — the parent path / breadcrumb is reconstructed client-side from the tree returned by `GET /api/artifacts/tree` (which we already load for the panel). This avoids a server-side recursive CTE.

### 11.4 Out of scope (defers to later milestones)

- Search across the tree (M2 ships a flat client-side filter; full-text search is M4+).
- Drag-and-drop reorder / reparent (PATCH `displayOrder` / `parentId` exists, but no DnD UI in M2).
- Multi-select bulk delete.
- Dashboard library panel + detail (M3).
