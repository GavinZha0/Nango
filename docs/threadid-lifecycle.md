# threadId Lifecycle

> How CopilotKit v2's thread identifier flows through Nango — from
> fresh-chat welcome through first run, backend session continuity, and
> history navigation.
>
> Audience: frontend engineers touching the chat surface, hooks, or the
> Zustand workspace store.
>
> See also:
>   - `docs/chat-flow-audit.md` §1 — full root-cause analysis of the
>     existing↔clone bug that the current model is designed to avoid.
>   - `docs/orchestrator.md` §9 — server-side chat history endpoints
>     (`/api/threads*`) that consume the threadIds captured here.
>   - `docs/runner-events.md` §6 — how `entity_run_event` rows replay
>     into the AG-UI `Message[]` that hydrates `<CopilotChat>` on
>     history restore.

## What Is threadId?

`threadId` is a UUID that uniquely identifies a conversation in
CopilotKit v2. It serves two purposes:

1. **Frontend**: keys CopilotKit's WeakMap of per-thread agent clones
   (`useAgent` returns the same clone for the same `(agentId, threadId)`
   pair, with its own `messages` and `state`).
2. **Backend**: maps 1:1 to each backend's native session identifier so
   history queries and session memory stay in sync.

### Backend Mapping

| Backend | threadId maps to | Mechanism |
|---|---|---|
| agno | `session_id` | Direct — agno's AG-UI bridge uses threadId as its session_id. |
| Mastra | `memory.thread` | Forwarded in the request body; Mastra's `prepare-memory-step` creates or continues a thread keyed by this id. |
| Dify | `conversation_id` | Persisted in `backend_thread_state` (`state.dify.convId`), keyed by `(credentialId, threadId)`. LRU cache in `lib/backends/thread-state.server.ts` lazy-hydrates from the DB. First message of a new thread omits `conversation_id` so Dify allocates fresh; captured from `message_end` and persisted. Survives Node restarts. |

---

## Two-Field Store Model

`workspace.threadId` was split (Nov 2026, see audit §1.11) because a
single field was ambiguously serving two disjoint purposes. Today:

```ts
runtimeThreadId: string | null  // live id; what thread am I in *right now*?
explicitThreadId: string | null // caller-picked id (history/URL restore)
```

| Field | Set by | Consumed by | Flows into `<CopilotChat>`? |
|---|---|---|---|
| `runtimeThreadId` | Lazy-capture in `RightPanel.ChatProviderHooks` (after first `onAgentRunStarted`); also `HistoryPanel.handleSelectSession` mirrors it. | History list "active row" marker, `useSaveOutcome`, `useOutcomeTools`, `OutcomesPanel`, outcome attribution. | **No.** Feeding it back would flip `hasExplicitThreadId` false → true mid-session and break Inv-2. |
| `explicitThreadId` | `HistoryPanel.handleSelectSession`; future URL-restore hook. | `ChatPanelBody` only. | **Yes.** Drives `<CopilotChat threadId>`. `null` = fresh-chat mode. |

Treat these as **disjoint write streams**. The only hook that knows
about both is `HistoryPanel`, which sets both on click (history-restore
is the one place that legitimately wants `<CopilotChat>` in explicit
mode AND the live-id tracker pointing at the same thread).

---

## CopilotKit v2 Recommendation We Follow

```
fresh chat:
  app does NOT pass threadId
  CopilotKit internally mints non-explicit UUID = ABC
  hasExplicitThreadId = false
  → welcome screen shown
  → /connect skipped

first user message → /run carries ABC
  backend creates entity_run.thread_id = ABC
  ABC is now both frontend-known and backend-known

run started:
  RightPanel lazy-capture writes ABC → runtimeThreadId
  (NEVER writes to explicitThreadId)
  CopilotChat stays in non-explicit mode for the rest of the session

subsequent turns: same ABC, no remount, no transition

history click:
  HistoryPanel.handleSelectSession(XYZ)
    → setExplicitThreadId(XYZ)
    → setRuntimeThreadId(XYZ)
  CopilotChat receives threadId={XYZ} prop
  hasExplicitThreadId = true
  /connect called → DB replay
```

The key invariant: **ABC's identity changes phase, not value**. The
same UUID exists in CopilotKit's runtime from t0, is sent in the first
`/run` body, is persisted as `entity_run.thread_id`, and is reflected
back into `runtimeThreadId` after `onAgentRunStarted`. There is no
"local id later swapped for a real id".

---

## Per-Render Component Tree

```
ChatPanelBody                    reads store, decides fresh vs explicit
  └─ ChatPanelInner              owns the remount key (chatEpoch / agentId)
       └─ <CopilotChat threadId={explicitThreadId ?? undefined}>
            └─ <CopilotChatConfigurationProvider threadId=ABC ...>
                 └─ ChatViewShell                  ← chatView slot
                      └─ ChatViewShellBody          ← per-thread clone subtree
                           ├─ useAgent({agentId})   ← chatConfig fallback → ABC → clone B
                           ├─ useInjectHandoffContext(agentId, agent.threadId)
                           ├─ useOnRegenerate(agentId, agent.threadId)
                           └─ <CopilotChatView ... messageView={...}/>
```

`useOnRegenerate` and `useInjectHandoffContext` live **inside** the
chatView slot because they directly call `useAgent` and operate on
`agent.messages` / `agent.runAgent`. Calling them from outside the
config provider would resolve `useAgent` Branch A (the registry agent,
no thread) instead of Branch B (clone B). See `docs/chat-flow-audit.md`
§1.7.

---

## Lifecycle Events

### 1. Initial Mount (Fresh Chat)

- `workspace.runtimeThreadId = null`, `workspace.explicitThreadId = null`
- `<CopilotChat threadId={undefined}>` →
  CopilotKit internally `resolvedThreadId = randomUUID() = ABC`
- `hasExplicitThreadId = false` → welcome screen shown
- `/connect` is skipped (backend has never seen ABC)
- ChatViewShell rendered inside the config provider; its `useAgent`
  resolves clone B via `threadId ??= chatConfig?.threadId`.

### 2. First User Message

- CopilotKit `onSubmit`: `agent.addMessage(user)` + `runAgent(agent)`
- Backend receives `/run { threadId: ABC, messages: [...] }`
- Backend creates `entity_run(thread_id=ABC)` and starts streaming SSE
- `onAgentRunStarted` fires globally; `RightPanel.ChatProviderHooks`
  captures `event.agent.threadId = ABC` into `pendingThreadIdRef`
- On `onRunFinalized`: `setRuntimeThreadId(ABC)` (only if still null)
- `<CopilotChat>` prop is still `undefined` → `hasExplicitThreadId`
  stays `false`. No remount, no agent swap.

### 3. Subsequent Turns

- ABC remains stable everywhere (agent, store, prop, backend).
- Welcome screen disappears (because `messages.length > 0`), but
  `hasExplicitThreadId` is still `false` — the threshold for hiding
  welcome is "there are messages", not "explicit thread".

### 4. History Click

- `HistoryPanel.handleSelectSession(XYZ)`:
  - `setExplicitThreadId(XYZ)`
  - `setRuntimeThreadId(XYZ)` (mirror — outcomes / save flows want
    "the live id")
- `ChatPanelBody` reads `explicitThreadId=XYZ`, passes to `<CopilotChat>`
- CopilotKit: `hasExplicitThreadId = true` → `/connect` invoked → DB
  replay populates `agent.messages`
- Welcome screen suppressed for the entire restored session.

### 5. New Chat Button

- `handleNewChat` calls `useWorkspaceStore.startFreshChat()`. Back to
  step 1.

**What `startFreshChat()` does atomically:**

1. `runtimeThreadId = null`
2. `explicitThreadId = null`
3. `chatEpoch += 1`

**Why the epoch (step 3) is needed.** In fresh-chat mode the
`<CopilotChat threadId>` prop stays `undefined`. Without a key bump,
clearing the two store fields is a chat-surface no-op:

- `MemoChat` is wrapped in `React.memo`; `undefined → undefined` is
  treated as no change → MemoChat skips re-render.
- Even on re-render, CopilotChat caches
  `resolvedThreadId = useMemo(() => providedThreadId ?? randomUUID(), [providedThreadId])`
  — `providedThreadId` (undefined) never changes, so `resolvedThreadId`
  stays at the first-mint ABC for the entire lifetime of the mounted
  component. `useAgent`'s WeakMap then keeps returning the same
  clone B with all its message history.

The only thing that breaks this lock-in is a full unmount of
`<CopilotChat>`, achieved via the React `key` containing `chatEpoch`.
Agent / Nango / handoff switches don't need to bump because `agentId`
is already part of the key.

**Why the field-clear (steps 1+2) is needed _alongside_ the bump.**
The epoch bump remounts CopilotChat, which then mints a brand new
internal ABC2. `RightPanel.ChatProviderHooks`'s lazy-capture writes
ABC2 into `runtimeThreadId` on the next `onAgentRunStarted` — but the
write is guarded by `if (state.runtimeThreadId) return;` to avoid
clobbering the live id when sibling runs finalize. If the caller
bumped the epoch *without* first clearing `runtimeThreadId`, the
guard would refuse the new ABC2 and the conversation would silently
lose its store-side identity. `startFreshChat()` exists precisely so
no caller can get this ordering wrong.

**Future entry points** that start a new conversation should call
`startFreshChat()`, not assemble the three steps manually.

### 6. Switch Agent

- `setActiveAgent(newId)` resets both threadId fields to null (unless
  the same agent is re-selected). `<CopilotChat key={`${agentId}:${chatEpoch}`}>`
  change is driven by `agentId` (no epoch bump needed); forces remount
  and a new fresh chat begins.

### 7. Delete Active Thread

- `HistoryPanel.handleDelete(sid)`: if `sid === runtimeThreadId`,
  calls `startFreshChat()` (same primitive as the New Chat button).
- Rollback path on network failure restores `runtime + explicit = sid`
  and bumps the epoch for symmetry — the explicit prop change alone
  would force re-render, but the bump keeps every "transition into a
  fresh chat surface" going through `chatEpoch++` so the state
  machine is uniform.

---

## Why eager-mint Was Removed

Earlier code in `WorkspaceProvider.tsx` used `useLayoutEffect` to
pre-mint a UUID into `workspace.threadId` before the first paint, so
that all external hooks (anything in `ChatPanelInner` calling
`useAgent`) would resolve to clone B from render one. This was needed
because those hooks could not see CopilotKit's internal
`CopilotChatConfigurationProvider`, so their `useAgent({threadId: undefined})`
fell through to Branch A (registry agent).

The chatView slot wrapper (`ChatViewShell`) moves those hook calls
*inside* the config provider, where `useAgent`'s built-in fallback
(`threadId ??= chatConfig?.threadId`) resolves clone B without any
pre-minting. Eager-mint is therefore unnecessary, and removing it
restores the CopilotKit-recommended fresh-chat semantics (welcome
screen, no `/connect` on empty thread).

For the full chain of reasoning, see `docs/chat-flow-audit.md` §1.

---

## Known Limitations

### Ghost runtimeThreadId after a first-run failure

Lazy-capture writes `runtimeThreadId = ABC` synchronously on
`onAgentRunStarted`, which fires *before* the `/run` POST has been
acknowledged by the backend. If the very first run of a fresh chat
fails immediately (network error, auth rejection, server returns 4xx
before creating an `entity_run` row), the store ends up with an `ABC`
that has no corresponding backend record.

**Symptoms** while the ghost id sticks around:
- `HistoryPanel` would highlight a row for ABC, but the history fetch
  doesn't return ABC (no `entity_run`), so visually no row matches.
- `useSaveOutcome` calling `POST /api/artifacts` with `thread_id=ABC`
  gets a 404.
- `outcomeStore.loadForThread(ABC)` returns empty.

**Self-recovery**: any of these clears it —
- Clicking "New Chat" (`startFreshChat()` zeroes the field).
- Switching to a different agent (`setActiveAgent` for a different
  id zeroes both threadIds).
- Refreshing the page (no threadId fields are persisted; only
  `pinnedSessions` survives).

**Why we don't auto-clear**: a naive "clear `runtimeThreadId` on
`onRunFailed`" would break the much more common case of "user's 4th
turn fails after 3 successful turns" — `runtimeThreadId` there points
at a perfectly valid thread we mustn't lose. A precise fix would need
to track "has any message event arrived for this id yet?" with another
ref + nested subscription, partly undoing the F1 simplification. The
ghost id is a rare, UX-visible, but non-destructive bug; we accept it
in exchange for the simpler lazy-capture code. Revisit if production
data shows it actually hurts.

---

## Key Files

| Concern | File |
|---|---|
| Store schema | `src/store/workspace.ts` |
| Hooks that need clone B (regenerate, handoff) | `src/components/right-panels/ChatPanel.tsx` (ChatViewShell) |
| Hooks that don't need clone B (timing) | `src/components/right-panels/ChatPanel.tsx` (ChatPanelInner) |
| Lazy capture into `runtimeThreadId` | `src/components/layout/RightPanel.tsx` (ChatProviderHooks) |
| History → explicit promotion | `src/components/right-panels/HistoryPanel.tsx` |
| Outcome attribution (uses `runtimeThreadId`) | `src/hooks/useSaveOutcome.ts`, `src/hooks/useOutcomeTools.tsx`, `src/components/workspace/ArtifactPanel.tsx`, `src/components/layout/WorkspaceProvider.tsx` (outcome subscriber) |

---

## Gotchas

- **Do not write `explicitThreadId` from anywhere except `HistoryPanel`
  or a future URL-restore hook.** Specifically: lazy-capture must NEVER
  write to it (would re-introduce the bug eager-mint was hiding).
- **Do not pass `runtimeThreadId` to `<CopilotChat>`.** Use
  `explicitThreadId` only. `ChatPanelBody` is the single allowed reader
  for the prop.
- **Same-id history click is currently a remount.** If the user clicks
  the row corresponding to the active thread (`runtimeThreadId ===
  rowId`), `setExplicitThreadId(rowId)` flips
  `hasExplicitThreadId` false → true and triggers a `/connect` that
  replays the messages we already have. Cheap, idempotent, but not
  zero-cost — consider a no-op guard in `handleSelectSession` if it
  matters.
- **Welcome screen only shows when `messages.length === 0`.** After
  the first run completes, even though `hasExplicitThreadId` is still
  `false`, the message view takes over because there are messages to
  render. The two conditions are AND-ed inside CopilotKit's
  `CopilotChatView`.
