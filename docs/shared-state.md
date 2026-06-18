# Shared State Architecture

Status: proposed · last updated: 2025-06-14

## 1) Product Positioning

Shared state is a **UX capability**, not the orchestration core.

Goals:
1. Agent knows where the user is and what they are looking at (all pages).
2. Agent can propose interactive edits on pages that opt in.
3. Artifact/workflow editing gets strongest support (primary use case).

Non-goals:
- Full auto-mutation platform across all resources
- Generic event-sourcing / command bus
- Cross-session draft recovery
- Central capability registry or tier config

---

## 2) Design Principles

### 2.1 Editability is opt-in, not configured

There is **no central capability registry** and no tier mapping.

A page becomes editable by calling the `useCopilotDraft` hook. That hook:
1. Reports the page's current data as `activeResourceData` in shared state.
2. Listens for draft proposals from the agent and applies them locally.

If a page does not call `useCopilotDraft`, its `activeResourceData` is `null`.
The agent tool handler rejects draft writes when `activeResourceData` is `null`.

This means:
- Adding draft support to a new page = add `useCopilotDraft` (one hook call).
- No config file to maintain, no registry to update.
- The agent naturally infers what is editable from the data it sees.

### 2.2 All pages get context — no exclusions

Every workspace page (including admin pages) automatically provides
`activeView` + `activeUrl` to the agent via URL-based resolution.
No page is excluded. Admin pages simply do not call `useCopilotDraft`,
so they are read-only by default.

### 2.3 Assist-edit first, not blank-form creation

The current scope of `propose_page_edit` targets **modifying existing
resources** — the agent sees `activeResourceData` as a complete example
and proposes changes on top of it. Creating resources from a blank form
is a harder problem (agent lacks field definitions, required/optional
constraints, enum values, format rules) and is deferred to a future
phase. For creation flows, the agent should use backend tools
(`create_schedule`, etc.) or guide the user conversationally.

### 2.4 No auto-commit

Draft tools **never** write to the database. The user must explicitly
click Save after reviewing the proposed changes.

---

## 3) State Model

Keep the existing `NangoSharedState` shape (defined in
`src/lib/copilot/shared-state-schema.ts`):

```ts
interface NangoSharedState {
  /** Frontend -> Agent: page awareness */
  context: {
    activeUrl: string;
    activeView: ActiveView;          // resolved from URL
    activeResourceId?: string | null;
    activeResourceData?: Record<string, unknown> | null;
  };
  /** Agent -> Frontend: proposed edits */
  drafts: {
    [resourceType: string]: Record<string, unknown> | undefined;
  };
}
```

Notes:
- `activeResourceData` is populated **only** when the page calls
  `useCopilotDraft`. It serves as both the agent's read context and
  the editability signal.
- `drafts` is keyed by resource type (e.g. `"schedule"`, `"workflow"`,
  `"skill"`). Each value is the full proposed object.
- Remove the unused `uiAction` field from the current implementation.

---

## 4) Lifecycle

- **Agent switch**: clear all drafts and reset `activeResourceData`.
  Implemented as a `useEffect` on `activeAgentId` in the sync hook.
- **Page navigation**: `activeResourceData` is automatically cleared
  when the old editor unmounts (via `useCopilotDraft` cleanup).
- No session-key map needed. CopilotKit agent state is already per-agent.

---

## 5) Frontend Tools

Two tools, registered in `useCopilotSharedStateSync`:

### 5.1 `propose_page_edit`

Purpose: agent proposes changes to the currently visible editor.

Parameters:
- `resourceType: z.enum(["schedule", "workflow", "skill", ...])` — constrained enum
- `draftData: z.record(...)` — the full proposed object (always replace, no merge)

Guard (inline in handler, ~3 lines):
- If `activeResourceData === null` → reject with message
  `"Current page has no editable data. Use backend tools or ask the user to navigate."`
- If `resourceType` does not match `activeView` → reject with mismatch message

### 5.2 `discard_page_edit`

Purpose: agent explicitly clears its own draft.

Parameters:
- `resourceType: z.enum([...])`

### 5.3 Not implemented (intentionally)

- ❌ `ui_hint` — premature; add specific tools when specific needs arise.
- ❌ `merge` mode — all drafts use replace. Agent sends full object.

---

## 6) Context Injection

Handled by one central hook: `useCopilotSharedStateSync` (inside
CopilotKitProvider, mounted in `RightPanel.tsx`).

Responsibilities:
1. Resolve `activeView` + `activeResourceId` from `usePathname()`.
2. Read `activeResourceData` from Zustand (set by whichever editor
   is mounted via `useCopilotDraft`).
3. Sync the combined context into CopilotKit agent state.
4. Mirror agent state back to Zustand for cross-component access.

No per-page extractor functions needed. Each editor's `getCurrentData()`
callback (passed to `useCopilotDraft`) is the only data source.

### 6.1 Schema / format guidance for the agent

The agent infers field semantics from the **current data values** — this
works well for editing existing resources where every field already has
a sample value.

For common format concerns, brief hints are embedded in the
`propose_page_edit` tool description (e.g. date format, cron syntax).
No per-resource JSON Schema is maintained.

For **workflow** specifically, `getCurrentData()` may include structural
metadata (available node types, input/output definitions) alongside the
graph data, so the agent can understand the graph vocabulary.

### 6.2 Read-only page context (extension point, not yet needed)

Some pages may want to provide the agent with extra read-only context
(e.g. notification summaries, dashboard statistics) without being
editable. This is **not currently implemented**.

When the need arises, add a `pageInfo` field to
`NangoSharedState.context` (separate from `activeResourceData`). The
tool guard only checks `activeResourceData`, so `pageInfo` carries no
editability signal. This is a ~5-line schema change.

---

## 7) Page Integration Patterns

### Read-only pages (no code change needed)

dashboard, notifications, verification, evaluation, outcomes, profile,
all admin pages, all list pages.

These pages get `activeView` + `activeUrl` automatically.
Agent can answer contextual questions but cannot propose edits.

### Form editors (light editing, `useCopilotDraft`)

schedule, skill, agent, mcp, datasource, ssh-server.

Each editor adds ~15 lines:
```ts
const getCurrentData = useCallback(() => (form as Record<string, unknown>), [form]);
const applyDraft = useCallback((draft) => { setForm(f => ({ ...f, ...draft })); }, []);
const { draftApplied, clearDraftState } = useCopilotDraft({
  resourceType: "schedule",
  getCurrentData,
  applyDraft,
});
```

UI shows amber Save button when `draftApplied === true`.

### Artifact / Workflow editor (strong editing, priority)

- `useCopilotDraft` with `resourceType: "workflow"`
- `getCurrentData` returns `{ nodes, edges }` graph
- `applyDraft` replaces the working graph (not DB)
- UI must provide: draft indicator, visual diff/preview, discard, explicit save
- This is the **primary engineering effort** of the feature

---

## 8) Policy Rules (Hard Guardrails)

1. `propose_page_edit` rejected when `activeResourceData === null`.
2. No draft tool ever writes to the database.
3. Agent switch clears all drafts immediately.
4. If `resourceType` / `activeView` mismatch, tool returns error.
5. Supervisor prompt instructs agent: use `propose_page_edit` only when
   `state.context.activeResourceData` is present; otherwise use backend
   tools or conversational guidance.
6. `propose_page_edit` targets editing existing data. For blank-form
   creation, the agent should use backend tools or conversation.

---

## 9) File Organization

### 9.1 Existing Files (no new files needed)

| File | Role |
|------|------|
| `src/lib/copilot/shared-state-schema.ts` | `NangoSharedState` type + `defaultSharedState` |
| `src/store/copilot.ts` | Zustand bridge (CopilotKit ↔ non-Provider components) |
| `src/hooks/useCopilotSharedState.ts` | Sync hook + tool registration (inside Provider) |
| `src/hooks/useCopilotDraft.ts` | Per-editor consumer hook |

### 9.2 Files to Update

| File | Change |
|------|--------|
| `src/hooks/useCopilotSharedState.ts` | Rename tool → `propose_page_edit`, add `discard_page_edit`, add guard, add agent-switch cleanup |
| `src/lib/copilot/shared-state-schema.ts` | Remove unused `uiAction` field |
| `src/lib/constants/supervisor.ts` | Update prompt with new tool names and `activeResourceData` rule |
| `src/components/layout/RightPanel.tsx` | Already mounted — no change expected |

### 9.3 Editors to Integrate (per-editor ~15 lines)

| Editor | Status |
|--------|--------|
| `ScheduleEditor.tsx` | ✅ Done |
| `SkillEditor.tsx` | ✅ Done |
| `AgentEditor.tsx` | Pending |
| `McpEditor` (if exists) | Pending |
| `DataSourceEditor.tsx` | Pending |
| `SshServerEditor.tsx` | Pending |
| Artifact / Workflow editor | Pending (main effort) |

---

## 10) Acceptance Criteria

1. Agent knows current page (`activeView` + `activeUrl`) on every page.
2. `propose_page_edit` works end-to-end on Schedule and Skill editors.
3. `propose_page_edit` is rejected on pages without `useCopilotDraft`.
4. No shared-state path commits DB changes without explicit user Save.
5. Switching agent clears all drafts immediately.
6. Workflow editor supports full graph draft with preview and explicit save.

---

## 11) Implementation Plan and Workload Assessment

### Phase 1 — Core refactoring (from current implementation)

| # | Task | Size | Risk | Notes |
|---|------|------|------|-------|
| 1 | Rename tool `update_shared_state` → `propose_page_edit` | **S** | low | Search-replace in sync hook + supervisor prompt |
| 2 | Add `discard_page_edit` tool | **S** | low | ~10 lines in sync hook |
| 3 | Tighten `resourceType` param to `z.enum([...])` | **S** | low | One line change |
| 4 | Add `activeResourceData === null` guard in tool handler | **S** | low | ~3 lines |
| 5 | Add agent-switch cleanup `useEffect` | **S** | low | ~5 lines |
| 6 | Remove unused `uiAction` from schema | **S** | low | Delete ~8 lines |
| 7 | Update supervisor prompt | **S** | medium | Prompt wording correctness matters |

**Phase 1 total: S** — half-day work, low risk.

### Phase 2 — Remaining editor integrations

| # | Task | Size | Risk | Notes |
|---|------|------|------|-------|
| 1 | Integrate `useCopilotDraft` into remaining editors (agent, datasource, ssh-server, mcp) | **S** | low | ~15 lines each, same pattern as Schedule/Skill |
| 2 | Polish draft UX (amber badge, discard button) across editors | **S** | low | Consistent UI pattern |

**Phase 2 total: S** — half-day to one-day work.

### Phase 3 — Artifact / Workflow editing (priority, main effort)

| # | Task | Size | Risk | Notes |
|---|------|------|------|-------|
| 1 | Design workflow draft shape (`nodes`, `edges` graph) | **S** | medium | Need to align with existing workflow data model |
| 2 | Integrate `useCopilotDraft` into workflow editor | **M** | medium | Graph data is more complex than flat forms |
| 3 | Implement visual diff / preview for graph changes | **L** | high | Core UX challenge: show what nodes/edges changed |
| 4 | Add discard / explicit save flow | **S-M** | medium | Must not corrupt working graph state |
| 5 | Test with real agent interactions | **M** | medium | Prompt tuning for graph-quality output |

**Phase 3 total: L** — primary engineering effort and risk concentration.

### Overall Summary

| Scope | Size | Timeline Estimate |
|-------|------|-------------------|
| Phase 1 (core refactoring) | **S** | 0.5 day |
| Phase 1 + 2 (all editors except workflow) | **S-M** | 1-1.5 days |
| Phase 1 + 2 + 3 (full rollout incl. workflow) | **L** | 5-8 days |

**Primary risk**: Phase 3 workflow graph diff/preview. Everything else
is incremental and pattern-based.
