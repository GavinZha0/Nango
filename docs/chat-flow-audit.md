# Chat Flow Audit

Living document. Records concrete inconsistencies, races, and design
trade-offs discovered while walking the chat message flow.

Cross-refs:
- `docs/threadid-lifecycle.md` — threadId lazy-capture flow
- `docs/runner-events.md` — `entity_run` / `entity_run_event` pipeline
- `docs/builtin-runtime.md` — agent pool, MCP/skill caches

---

## Status Summary

### Fixed

| Issue | Solution | Key files |
|---|---|---|
| External `useAgent` calls resolved registry agent (Branch A) while CopilotChat rendered per-thread clone (Branch B) → UI never updated | `chatView` slot wrapper (`ChatViewShell`) moves external hooks inside the chat config provider | `ChatPanel.tsx` |
| `workspace.threadId` used for both recording and feeding back to `<CopilotChat>` → flipped `hasExplicitThreadId` mid-session | Store split: `runtimeThreadId` (record-only) + `explicitThreadId` (drives `<CopilotChat>` prop) | `store/workspace.ts` |
| Eager-mint `useLayoutEffect` forced `hasExplicitThreadId = true` on every fresh chat → welcome screen unreachable, wasted `/connect` call | Removed; `chatView` slot uses `chatConfig` fallback instead | `WorkspaceProvider.tsx` |
| `CopilotChatView` / `CopilotChatViewProps` not re-exported | Added to `src/lib/copilot/client.ts` | `client.ts` |
| HITL "flash to welcome" bug — picker unmounts after ~300 ms, chat reverts to welcome screen | Frozen stable refs for `properties`, `agents__unsafe_dev_only`, `selfManagedAgents` on `<CopilotKitProvider>` | `RightPanel.tsx` |

### Still Open

| Issue | Section |
|---|---|
| History click on currently-active thread — remount or no-op? | §1.7 |
| Docs/comments rewrite (`threadid-lifecycle.md`, `ChatPanel.tsx:175-178`) | §1.6 |

---

## 1. threadId — UI Side

### 1.1 Background: CopilotKit v2 `useAgent` clone semantics

`@copilotkit/react-core` resolves agents via two branches:

```js
const existing = copilotkit.getAgent(agentId);
if (!threadId) return existing;                              // Branch A
return getOrCreateThreadClone(existing, threadId, headers);  // Branch B
```

Clones are cached in a `WeakMap(registryAgent -> Map(threadId -> clone))`.
`cloneForThread` calls `existing.clone()` + `setMessages([])` + `setState({})`.

The core problem: if external hooks (outside `<CopilotChat>`) resolve
Branch A while the chat UI resolves Branch B, they operate on different
agent instances with different `messages` arrays.

### 1.2 The `chatView` slot solution (implemented)

`<CopilotChat>` wraps its children in a `CopilotChatConfigurationProvider`
that publishes `chatConfig.threadId = resolvedThreadId`. The `chatView`
slot prop renders **inside** this provider.

`ChatViewShell` (in `ChatPanel.tsx`) is our slot wrapper. It moves
`useOnRegenerate` and `useInjectHandoffContext` inside the provider
subtree, so `useAgent`'s `threadId ??= chatConfig?.threadId` fallback
fires and all hooks resolve the same clone (Branch B).

```tsx
function ChatViewShell(slotProps: CopilotChatViewProps) {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  if (!activeAgentId) return <CopilotChatView {...slotProps} />;
  return <ChatViewShellBody agentId={activeAgentId} slotProps={slotProps} />;
}

<CopilotChat
  agentId={activeAgentId}
  threadId={explicitThreadId ?? undefined}
  chatView={ChatViewShell}
  ...
/>
```

### 1.3 Store split (implemented)

`workspace.threadId` was split into two fields with disjoint semantics:

```ts
type WorkspaceThreadState = {
  // Recorded after onAgentRunStarted. Used by history list, URL sync,
  // GET /api/threads, useThreadHydration. NEVER passed to <CopilotChat>.
  runtimeThreadId: string | null;

  // Only set when user explicitly chose a stored thread (history click,
  // URL navigation). Flows into <CopilotChat threadId={...}>.
  explicitThreadId: string | null;
};
```

`<CopilotChat>` consumes only `explicitThreadId`. For fresh chats it is
`null` (→ `undefined` prop → `hasExplicitThreadId = false`). For history
restore it is the stored thread ID (→ `hasExplicitThreadId = true` →
triggers `/connect`).

### 1.4 Invariants

- **Inv-1.** Throughout one mounted `<CopilotChat>` session, `agent.threadId`
  must remain stable.
- **Inv-2.** For a *fresh* session, `hasExplicitThreadId` must remain `false`
  until the user explicitly switches to a history thread. Re-feeding the
  auto-minted UUID as an explicit prop is a silent violation.
- **Inv-3.** The agent instance subscribed by UI and the agent instance
  written to by `runAgent` must be the same object — all `useAgent` calls
  in scope must resolve to the same Branch for the same key.
- **Inv-4.** The store may *know* the runtime thread ID (for history/URL/API),
  but that knowledge must not flow back into `<CopilotChat>` as an explicit
  prop during the same session.

### 1.5 Affected external-hook call sites

Two direct `useAgent` calls outside the CopilotChat subtree (now moved
into `ChatViewShell`):

| # | Hook | File | Why it needs the per-thread clone |
|---|---|---|---|
| 1 | `useOnRegenerate` | `ChatPanel.tsx` | Reads `agent.messages`, calls `setMessages(truncated)`, re-runs. Must operate on the same instance UI renders. |
| 2 | `useInjectHandoffContext` | `useHandoff.ts` | Calls `agent.setMessages([handoffText])` + `runAgent` on mount. Operating on registry agent A would dispatch a run UI never sees. |

Indirectly affected (safe iff the run was started on clone B):

- `RightPanel.ChatProviderHooks` — subscribes via `copilotkit.subscribe({
  onAgentRunStarted })` and `event.agent.subscribe(...)`. Now writes to
  `runtimeThreadId` (one-way record).

### 1.6 Remaining: documentation updates

The following docs/comments still describe the old model and need rewriting:

- `docs/threadid-lifecycle.md` — documents only the legacy lazy-capture
  flow; does not mention `ChatViewShell` or the store split.
- `ChatPanel.tsx:175-178` — comment claims "threadId undefined triggers
  v2's welcome screen" which is now accurate but was false under the old
  eager-mint regime. Verify the comment matches current behavior.

### 1.7 Open question: history click on active thread

If `runtimeThreadId === ABC` and user clicks `ABC` in the history list,
do we:

- **(a)** Promote to `explicitThreadId = ABC` — causes remount + `/connect`
  that replays the same messages we already have, or
- **(b)** No-op — avoids wasted work but may confuse users expecting a
  "refresh".

Either is defensible. Decision deferred to implementation.

---

## 2. HITL "Flash to Welcome" Bug (Fixed)

### Problem

When a frontend HITL tool (e.g. `ask_user_datetime`) emitted a tool call,
the picker mounted for ~300 ms, then disappeared. The chat reverted to the
welcome screen (empty messages) and the HITL handler's Promise stayed
pending forever. Reproduced deterministically on CopilotKit 1.56.3 and
1.57.3.

### Root cause

`<CopilotKitProvider>` destructures three props with `= {}` defaults:
`properties`, `agents__unsafe_dev_only`, `selfManagedAgents`. Each render
allocates fresh empty-object references. These feed into a `useMemo` for
`mergedAgents` and a setter `useEffect` — both re-run every commit because
their deps are referentially unstable.

The setter effect calls `setRuntimeTransport("auto")`. On first connect,
`fetchRuntimeInfoAutoDetect` mutates `_runtimeTransport` to `"rest"` after
a successful `/info` probe. After that, the dedup check
`_runtimeTransport === "auto"` always returns `false`, so every subsequent
effect run triggers a full runtime reconnect:

1. Status -> `"connecting"`, re-fetches `/info`.
2. Remote agents rebuilt from scratch with blank `messages` arrays.
3. `useAgent` returns the new empty agent -> welcome screen.
4. `ToolCallRenderer` can't find the assistant message -> picker unmounts.
5. HITL Promise stays pending forever.

### Fix

Pass module-level `Object.freeze`-d stable empty refs for all three
defaulted props (`RightPanel.tsx`):

```ts
const STABLE_EMPTY_AGENTS = Object.freeze({}) as Record<string, never>;
const STABLE_EMPTY_PROPS  = Object.freeze({}) as Record<string, unknown>;

<CopilotKitProvider
  properties={STABLE_EMPTY_PROPS}
  agents__unsafe_dev_only={STABLE_EMPTY_AGENTS}
  selfManagedAgents={STABLE_EMPTY_AGENTS}
>
```

Stable refs keep the setter effect's deps equal across commits -> no
re-run -> no reconnect -> agent instances stay in place -> picker stays
mounted.

### Lesson learned

- **Defaults are dangerous on context provider props.** If a third-party
  provider destructures props with `= {}` defaults, always pass an
  explicit stable ref — even if your prop reference is stable, an
  unrelated prop's default `{}` can destabilize the deps array.
- **Mutating auto-detection state inside a React effect's dependency
  chain creates a one-way trap door.** The `fetchRuntimeInfoAutoDetect`
  mutation is fine in isolation; it becomes a bug when the upstream
  caller is a re-firing effect.
