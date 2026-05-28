# Role-Based Access Control (RBAC)

> Status: v1
> Audience: backend / frontend engineers touching auth, route guards, or
> resource CRUD
> See also: `docs/architecture.md` §security, `AGENTS.md` §"Architecture Rules"

This document is the single source of truth for **roles, resource
visibility, ownership, and the user-deletion lifecycle** in Nango.

---

## 1. Roles

Three roles, ordered from most to least privileged:

| Role | Purpose | Typical user |
|---|---|---|
| `admin` | System operator. Manages secrets, users, and observes everything. | Platform owner / DevOps |
| `editor` | Builder. Creates and maintains AI resources for the team. | Internal team member, prompt engineer |
| `user` | Consumer. Uses what's already built; produces only their own threads / artifacts / schedules. | End customer, occasional internal user |

### Role assignment

| Event | Role |
|---|---|
| First sign-up to a fresh database | `admin` (auto-promoted via `databaseHooks.user.create.before`) |
| Subsequent self sign-up | `user` (the better-auth `defaultRole`) |
| Promotion / demotion | Manual, by any `admin` via `/admin/users` |

`admin` cannot demote themselves if they would leave the system with
zero admins. The route returns 409 CONFLICT.

### Better-auth integration

The role lives in `user.role` (text). `better-auth/plugins/admin` is
configured with:

```ts
adminPlugin({
  defaultRole: "user",
  adminRoles: ["admin"],
}),
```

`adminRoles: ["admin"]` only governs which roles can call the admin
plugin's *built-in* APIs (listUsers, banUser, impersonate, etc.).
Application-level authorisation (editor, public/private rules) lives
in our own route guards and is independent.

---

## 2. Permission matrix

### 2.1 Functional capabilities

| Capability | admin | editor | user |
|---|---|---|---|
| **User & secrets management** | | | |
| `/admin/users` CRUD | ✅ | ❌ | ❌ |
| `/admin/credentials` CRUD | ✅ | ❌ | ❌ |
| `/admin/thread` (thread / run forensics) | ✅ | ❌ | ❌ |
| **AI resource construction** | | | |
| Create / edit / delete `skill` (own private + any public) | ✅ | ✅ | ❌ |
| Create / edit / delete `mcp_server` (same rule) | ✅ | ✅ | ❌ |
| Create / edit / delete `builtin_agent` (same rule) | ✅ | ✅ | ❌ |
| Bind credentials when creating agents (read-only credential picker) | ✅ | ✅ | ❌ |
| **Use & produce** | | | |
| Chat with any visible agent | ✅ | ✅ | ✅ |
| `schedule` CRUD (own only) | ✅ | ✅ | ✅ |
| `thread` / `artifact` (own only) | ✅ | ✅ | ✅ |
| Receive notifications | ✅ | ✅ | ✅ |
| **Observability of own runs** | ✅ | ✅ | ✅ |

### 2.2 Resource-level rules (skill, mcp_server, builtin_agent)

These three tables share the same RBAC × visibility × ownership rules:

```
canView    = (visibility == 'public')
          OR (createdBy == self)
          OR isAdmin

canEdit    = source != 'builtin'
          AND isEditorOrAdmin
          AND ((visibility == 'public') OR (createdBy == self))

canDelete  = source != 'builtin'
          AND ((createdBy == self) OR isAdmin)

canChangeVisibility = canDelete    // same gate as delete

canToggleEnabled    = canChangeVisibility   // owner / admin only
```

`source != 'builtin'` is an **absolute write barrier**: built-in
resources (shipped via image / build artefact) are never editable
through the UI, regardless of role. Want to customise a builtin?
Wait until v2 introduces `Duplicate`; for now, contribute the change
to the codebase.

### 2.3 `credential` rules

Credentials are admin-only. Every CRUD route is `withAdmin`. The
`updatedBy` column tracks which admin last touched the row (multi-admin
deployments).

### 2.4 Owner-only resources

`schedule`, `artifact`, `thread`, `notification` are not subject to the
visibility model. They belong to a single owner and only that owner
(plus admin for forensics) can read or write them.

---

## 3. Visibility model

### 3.1 Three signals, all on the row

| Column | Values | Meaning |
|---|---|---|
| `visibility` | `private` \| `public` | Who can see this row |
| `source` | `builtin` \| `local` | How the row was created (build-time vs runtime) |
| `createdBy` | uuid → `user` | Original author; never changes during the row's lifetime |
| `updatedBy` | uuid → `user` (nullable) | Last user who modified; refreshed on every PATCH |

Additionally, the existing `enabled: boolean` toggle is independent of
all three — it's a soft on/off flag the owner / admin can flip without
deleting.

### 3.2 Default values on create

| Field | Default |
|---|---|
| `visibility` | `private` |
| `source` | `local` (built-in resources are seeded by the system, not the API) |
| `createdBy` | the calling user's id |
| `updatedBy` | `NULL` (no edit yet) |
| `enabled` | `true` |

### 3.3 The collaboration story

When an editor flips a resource from `private` to `public`, **other
editors can edit its content** (this is intentional team-collaboration
mode). What only the original author or admin can do:

- Delete the row.
- Flip visibility back to `private`.
- Toggle `enabled`.

Concrete: Alice (editor) creates `csv-summary` skill, marks it public.
Bob (editor) refines the SKILL.md content. The row now shows:

- `createdBy = Alice`
- `updatedBy = Bob`
- The UI displays "Created by Alice on … · Last edited by Bob on …".

If Bob tries to delete it, the API returns 403. Only Alice or any admin
can delete.

---

## 4. User lifecycle: soft delete

### 4.1 Why soft delete

A hard `DELETE FROM user WHERE id = ?` would either cascade and wipe
the user's contributed resources (bad — public skills shouldn't vanish
because the author left) or block on FK constraints (worse UX).

Soft delete sidesteps both. The user row stays forever; only its
`deleted_at` timestamp marks it inactive.

### 4.2 Schema

```sql
ALTER TABLE "user" ADD COLUMN deleted_at  timestamp;
ALTER TABLE "user" ADD COLUMN deleted_by  uuid REFERENCES "user"(id) ON DELETE SET NULL;

-- Email unique only among active rows
DROP INDEX IF EXISTS user_email_key;
CREATE UNIQUE INDEX user_email_active_idx ON "user"(email)
  WHERE deleted_at IS NULL;
```

### 4.3 What happens at soft delete

```
admin clicks "Delete user" on /admin/users
  ↓
DELETE /api/admin/users/:id
  ↓
  - UPDATE user SET deleted_at = NOW(), deleted_by = adminId WHERE id = :id
  - DELETE FROM session WHERE user_id = :id      ← sessions immediately invalid
  ↓
The user's next request returns 401 (no session).
Their email is now reusable for a new sign-up.
Their public resources keep their createdBy = oldUserId; UI shows
"Created by X (deleted)".
```

### 4.4 Application-layer filtering

Every query that returns a user row (login, session resolution, listing
admin users) MUST filter `deleted_at IS NULL`. The session resolver
in `auth-instance.ts` rejects sessions belonging to a soft-deleted user.

UI displays of `createdBy` / `updatedBy` show `(deleted)` next to the
display name when the referenced user has `deleted_at != NULL`.

### 4.5 FK strategy on resource tables

To keep "soft delete" robust **even if** a future operator decides to
hard-purge a deleted user (e.g. for GDPR), all `created_by` /
`updated_by` columns on resource tables use `ON DELETE SET NULL`:

```
skill.created_by, skill.updated_by                  → SET NULL
mcp_server.created_by, mcp_server.updated_by        → SET NULL
builtin_agent.created_by, builtin_agent.updated_by  → SET NULL
credential.created_by, credential.updated_by        → SET NULL
schedule.created_by, schedule.owner_id              → keep CASCADE (owner-only data)
artifact.created_by                                 → keep CASCADE (same)
thread / entity_run / notification                  → keep CASCADE
```

Soft delete is the daily path; hard purge is a deliberate admin action
for compliance, not the routine.

### 4.6 Hard purge (future)

A `/admin/users/:id/purge` endpoint can later perform a true `DELETE`
after the row has been soft-deleted long enough. Its behaviour:

- Refuse if `deleted_at IS NULL` (must soft-delete first).
- DELETE the row; FKs `SET NULL` automatically detach contributed resources.
- Owner-only resources (their threads, schedules, artifacts) are removed
  by CASCADE. This is the GDPR "right to be forgotten" path.

Not implemented in v1; the schema supports it without further changes.

---

## 5. Implementation surface

### 5.1 Route guards (Server Components / Pages)

`src/lib/auth/route-guards.ts`:

```ts
requireSession()    // any authenticated, non-deleted user
requireEditor()     // admin or editor
requireAdmin()      // admin only
```

All three redirect on failure — pages call them at the top of their
server component or layout.

### 5.2 API HOFs

`src/lib/http/route-handlers.ts`:

```ts
withSession(routePath, handler)   // any authenticated user
withEditor(routePath, handler)    // admin or editor (+ FORBIDDEN envelope)
withAdmin(routePath, handler)     // admin only (+ FORBIDDEN envelope)
```

### 5.3 Permission utilities

`src/lib/auth/permissions.ts` (new):

```ts
type ResourceWithRBAC = {
  source: "builtin" | "local";
  visibility: "private" | "public";
  createdBy: string | null;
};

canViewResource(r, sessionUser): boolean
canEditResource(r, sessionUser): boolean
canDeleteResource(r, sessionUser): boolean
canChangeVisibility(r, sessionUser): boolean
canToggleEnabled(r, sessionUser): boolean
```

These are **pure functions**; both API routes and Server Components
call them with the row + session.

### 5.4 Visibility-aware list queries

A reusable Drizzle helper for "rows visible to a session":

```ts
visibilityClause(sessionUser, table) → SQL fragment

// expands to:
//   visibility = 'public' OR created_by = $userId OR $isAdmin
```

Used in `/api/skills`, `/api/mcp-servers`, `/api/builtin-agents` GET
list endpoints.

### 5.5 `updatedBy` auto-set

API write paths automatically set `updatedBy` from the session at
PATCH time. POSTed (newly created) rows have `updatedBy = NULL` until
the first edit.

### 5.6 Frontend `useRole` hook

`src/hooks/useRole.ts`:

```ts
const { role, isAdmin, isEditor, isUser } = useRole();
```

`isEditor` is true for admins as well (admin ≥ editor). Conditional
rendering uses these flags to gate UI affordances:

- `LeftToolbar`: hides editor-only panels (Skills / MCP / Agent) for
  user role; hides admin-only routes (Credentials / Users / Run) for
  non-admin.
- Resource detail / editor pages: hide "Save" / "Delete" buttons when
  `canEdit` / `canDelete` is false.

### 5.7 UI display of authorship

Every resource detail panel header shows:

```
Created by Alice on 2026-04-12 · Last edited by Bob on 2026-05-04
```

`(deleted)` is appended to the display name when the referenced user
has been soft-deleted.

---

## 6. API surface

| Route | Guard | Notes |
|---|---|---|
| `/api/admin/users/*` | `withAdmin` | |
| `/api/admin/credentials/*` | `withAdmin` | |
| `/api/admin/threads/*` | `withAdmin` | thread list + thread detail (runs + metrics) |
| `/api/admin/runs/[id]` | `withAdmin` | single-run events (used by the thread detail right column) |
| `/api/skills` GET | `withSession` | filters by visibility |
| `/api/skills` POST/PATCH/DELETE | `withEditor` | + permission check (own private OR public) |
| `/api/skills/:id` GET | `withSession` | 404 if not visible |
| `/api/skills/:id/files/[...path]` GET | `withSession` | 404 if not visible |
| `/api/mcp-servers` GET | `withSession` | filters by visibility |
| `/api/mcp-servers` POST/PATCH/DELETE | `withEditor` | + permission check |
| `/api/builtin-agents` GET | `withSession` | filters by visibility |
| `/api/builtin-agents` POST/PATCH/DELETE | `withEditor` | + permission check |
| `/api/threads/*` | `withSession` | owner-only by `ownerId` |
| `/api/schedules/*` | `withSession` | owner-only by `ownerId` |
| `/api/copilotkit*` | `withSession` | visibility-checked at agent resolution |

---

## 7. Hard invariants

These are properties the system relies on; violating them is a bug.

1. **`source = 'builtin'` is immutable**: no UI write path may change a
   builtin row's content, visibility, or enabled state. Only the
   reconcile job may UPSERT them.

2. **`createdBy` never changes**: it's set once at INSERT and is the
   stable identity of the original author.

3. **`updatedBy` always points to a real user (or NULL)**: soft-deleted
   users still have rows, so the FK never breaks.

4. **Soft-deleted users cannot have active sessions**: deletion clears
   the `session` table for that user atomically.

5. **At least one admin always exists**: the demote / soft-delete API
   refuses if it would empty the admin set.

6. **`visibility = 'public'` does not imply `enabled = true`**: a public
   resource can be temporarily disabled without changing its visibility.

7. **Owner-only tables (`schedule`, `artifact`, `thread`,
   `notification`) ignore `visibility` entirely**: the owner is the
   sole reader / writer, plus admin for forensics.

---

## 8. Open questions / future work

- **Hard purge UX** (`/admin/users/:id/purge`): pending, low priority.
- **Audit log table**: current `updatedBy` field is enough for
  collaboration UX; a full audit table can be added later if compliance
  requires it.
- **Resource transfer**: when an admin wants to "give" Alice's resources
  to Bob (e.g. before purging Alice). v1 has no UI for this; admin can
  do it manually via SQL.
- **Group / team permissions**: not in v1. The single-tenant /
  small-team positioning lets us defer this. If it ever lands,
  `visibility` would extend to `private | team:<id> | public`.
- **`Duplicate` / fork builtin → local**: deferred per product decision;
  reconsider when users actually request it.
