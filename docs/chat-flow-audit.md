# Chat Flow Audit (Findings, No Fixes Yet)

Living document. Records every concrete inconsistency, race, or design
trade-off discovered while walking the chat message flow top-to-bottom.
**Nothing here is fixed yet** — we collect first, decide later in one pass.

Cross-refs:
- `docs/threadid-lifecycle.md` — historical write-up of the lazy-capture flow
- `docs/runner-events.md` — backend `entity_run` / `entity_run_event` pipeline
- `docs/builtin-runtime.md` — agent pool, MCP/skill caches

---

## §1. threadId — UI side

### 1.1 Two competing strategies coexist

| Layer | File | What it does |
|---|---|---|
| **eager-mint** (current) | `src/components/layout/WorkspaceProvider.tsx:91-96` | `useLayoutEffect`: when `activeAgentId !== null && threadId === null`, immediately set `threadId = crypto.randomUUID()` **before paint**. |
| **lazy-capture** (legacy) | `src/components/layout/RightPanel.tsx:312-358` | Subscribes to `onAgentRunStarted` → stashes `event.agent.threadId` in `pendingThreadIdRef` → on `onRunFinalized`, calls `setThreadId(captured)`. |
| **Sink** | `src/components/right-panels/ChatPanel.tsx:179-185` | `<MemoChat threadId={threadId /* may be undefined */} />` → eventually `<CopilotChat threadId={...} />`. |

Both are wired. Eager-mint runs first (layout effect, pre-paint) and almost
always wins; lazy-capture's `pendingThreadIdRef` is set but the value it
captures equals the value the store already holds → its `setThreadId(...)`
is a no-op.

### 1.2 Why eager-mint exists — CopilotKit v2 `useAgent` clone semantics

`@copilotkit/react-core` (`copilotkit-PzJlPKcU.mjs:3502-3556`):

```js
const existing = copilotkit.getAgent(agentId);
if (!threadId) return existing;                              // Branch A
return getOrCreateThreadClone(existing, threadId, headers);  // Branch B
```

`cloneForThread` calls `existing.clone()` + `setMessages([])` + `setState({})`.
Clones are cached in a module-level `WeakMap(registryAgent → Map(threadId → clone))`.

Switching `threadId` from `undefined` → `<uuid>` mid-run swaps the agent
instance the UI subscribes to (`existing` → `clone`) while the in-flight
`runAgent` keeps appending events to `existing.messages`. UI ends up
subscribed to an empty `clone.messages` → no updates render.

Eager-mint sidesteps this by forcing Branch B from the very first render.

### 1.3 Side effect — v2 welcome screen never appears

`@copilotkit/react-core` (`copilotkit-PzJlPKcU.mjs:6346`):

```js
if (messages.length === 0
    && !(welcomeScreen === false)
    && !isConnecting
    && !hasExplicitThreadId) {
  return <WelcomeScreen ... />;   // input + welcome message + suggestions
}
```

`hasExplicitThreadId` is `true` iff the `<CopilotChat>` prop is non-undefined.
Eager-mint guarantees it is always a uuid → the welcome branch is unreachable
in production. Empty-state UI is just the input bar at the bottom.

### 1.4 Documentation drift

- `docs/threadid-lifecycle.md` documents only the lazy-capture flow; doesn't
  mention `WorkspaceProvider.mintThreadId` at all.
- `src/components/right-panels/ChatPanel.tsx:175-178` comment claims
  "threadId undefined ... triggers v2's welcome screen" — false under
  current code.

### 1.5 Sites that null the threadId (all immediately re-minted)

- `setActiveAgent` switching to a different agent (`store/workspace.ts:196`)
- `enterNango` / `exitNango` / `enterAgent` (`store/workspace.ts:241,257,280`)
- `handleNewChat` in `RightPanel.tsx:155`
- `HistoryPanel.tsx:187` when the active thread is deleted

Every one of these is captured by the eager-mint `useLayoutEffect` and
replaced with a fresh uuid before the next paint. The "New Chat" button is
indistinguishable from "switch agent" from CopilotKit's perspective.

### 1.6 CopilotKit's recommended threadId semantics (the one we should be following)

After tracing v2 source end-to-end, the design is:

| Phase | App-side threadId prop | CopilotKit internal `resolvedThreadId` | `hasExplicitThreadId` | `/connect` | Welcome |
|---|---|---|---|---|---|
| **Fresh chat (initial paint)** | `undefined` | randomUUID() = `ABC` | `false` | skip | shown |
| **First user message → /run** | `undefined` | still `ABC` | `false` | skip | (message view takes over) |
| **Subsequent turns** | `undefined` | still `ABC` | `false` | skip | n/a |
| **History click / URL restore** | `XYZ` (DB row) | `XYZ` | `true` | called | hidden |

Key facts:
- `ABC` is *one* identifier — the same UUID is used by frontend `agent.threadId`,
  carried in `/run` body, and persisted as `entity_run.thread_id` server-side.
  There is no "local id later swapped for real id".
- App is allowed (and encouraged) to record `ABC` after first `onRunStarted`
  for history list / URL / API calls, **but must not feed it back to the same
  mounted `<CopilotChat>` as an explicit prop** — that flips
  `hasExplicitThreadId` false → true mid-session and changes semantics.
- "Explicit" is about *how* the id was chosen, not whether the string is set.
  An auto-minted UUID propagated through ChatConfigurationProvider stays
  non-explicit; a UUID handed in via the `threadId` prop is explicit.

### 1.7 Where the existing↔clone bug really lives

Source: `useAgent` (`copilotkit-PzJlPKcU.mjs:3539-3556`):

```js
const chatConfig = useCopilotChatConfiguration();
threadId ??= chatConfig?.threadId;        // ← fallback only works inside CopilotChat
const cacheKey = threadId ? `${agentId}:${threadId}` : agentId;
if (!threadId) return existing;           // Branch A: registry (no-thread) agent
return getOrCreateThreadClone(...);       // Branch B: per-thread clone (WeakMap-cached)
```

This means:

- **Inside `<CopilotChat>`** the `CopilotChatConfigurationProvider` always
  publishes `chatConfig.threadId = resolvedThreadId = ABC`, so internal
  `useAgent` calls always see `ABC` and always go to Branch B. Switching the
  outer prop from `undefined` → `ABC` does NOT swap the agent instance:
  WeakMap cache key is `${agentId}:ABC` in both cases, same clone B.
- **Outside `<CopilotChat>`** (Nango's `WorkspaceProvider`, `RightPanel`,
  `ChatPanel.useOnRegenerate`, `useThreadHydration`) there is no
  ChatConfigurationProvider in scope. `useAgent({ threadId: undefined })`
  takes Branch A and returns `existing` (the registry, no-thread agent).
  `useAgent({ threadId: ABC })` takes Branch B and returns clone B.

So the historical "UI doesn't refresh" bug is precisely: external hooks
called Branch A while CopilotChat internal hooks called Branch B → external
code subscribed to / wrote into `existing.messages`, UI rendered
`clone.messages`. Eager-mint fixes it by forcing every external hook into
Branch B from the very first render.

### 1.8 Invariants we want to preserve (per evaluator-A discussion)

- **Inv-1.** Throughout one mounted `<CopilotChat>` session, `agent.threadId`
  must remain stable as `ABC`.
- **Inv-2.** Throughout one *fresh* mounted session, `hasExplicitThreadId`
  must remain `false` until the user explicitly switches to a different
  (history) thread. Re-feeding the same `ABC` as an explicit prop is a
  silent invariant violation.
- **Inv-3.** The agent instance subscribed by UI (CopilotChat's internal
  `useAgent`) and the agent instance written to by `runAgent` must be the
  same object — i.e. all `useAgent` calls in scope must resolve to the
  same Branch (A or B) for the same key.
- **Inv-4.** Nango store may *know* `ABC` (for history, URL, API), but
  knowing it must not flow back into `<CopilotChat>` as an explicit prop
  during the same session.

### 1.9 Affected external-hook call sites (full list)

Two direct `useAgent` calls outside the CopilotChat subtree:

| # | Hook | File | Why it needs the per-thread clone |
|---|---|---|---|
| 1 | `useOnRegenerate` | `src/components/right-panels/ChatPanel.tsx:46` | Reads `agent.messages`, calls `setMessages(truncated)`, re-runs. Must operate on the same instance UI is rendering. |
| 2 | `useInjectHandoffContext` | `src/hooks/useHandoff.ts:114` | Calls `agent.setMessages([handoffText])` + `runAgent` on mount. Operating on registry agent A would dispatch a run UI never sees. |

Indirectly affected (via `event.agent.subscribe(...)` — safe iff the run was
started on clone B):

- `RightPanel.ChatProviderHooks` (`RightPanel.tsx:312-358`) — subscribes to
  `onAgentRunStarted` and `event.agent.subscribe({ onRunFinalized, ... })`.

This subscriber is only as correct as the agent the *originating* code
runs on. If `useInjectHandoffContext` (case 2) dispatches a run on
registry A by mistake, the downstream subscriber attaches to A's
lifecycle while UI is rendering B → capture-of-threadId silently
targets the wrong instance.

### 1.10 The clean solution: `chatView` slot wrapper (no eager-mint needed)

`<CopilotChat>` is itself wrapped in a `<CopilotChatConfigurationProvider
threadId={resolvedThreadId}>` internally (`copilotkit-PzJlPKcU.mjs:7030`),
and exposes a **`chatView` slot prop** that renders inside that provider
(line 7008). The slot's type is `SlotValue<typeof CopilotChatView>` — a
public API in `@copilotkit/react-core` (`copilotkit-DFaI4j2r.d.mts:1035`).

Sketch (not yet implemented; agentId comes from store/closure since
`CopilotChatViewProps` does **not** carry it — see verification #1 below):

```tsx
function NangoChatViewShell(slotProps: CopilotChatViewProps) {
  const agentId = useWorkspaceStore((s) => s.activeAgentId);
  if (!agentId) return <CopilotChatView {...slotProps} />;
  // Inside the CopilotChatConfigurationProvider subtree:
  // useAgent's `threadId ??= chatConfig?.threadId` fallback fires.
  const { agent } = useAgent({ agentId });
  // All hooks that previously lived in ChatPanelInner move here:
  useInjectHandoffContext(agentId, agent?.threadId);
  const onRegenerate = useOnRegenerate(agentId, agent?.threadId);
  // Compose messageView slot with onRegenerate-injected timing chip;
  // do NOT override slotProps.messages / onSubmitMessage / isRunning /
  // hasExplicitThreadId / isConnecting — those are CopilotChat's state.
  const messageView = useMemo(() => ({ assistantMessage: ... }), [onRegenerate]);
  return <CopilotChatView {...slotProps} messageView={messageView} />;
}

<CopilotChat
  agentId={activeAgentId}
  // No threadId prop in fresh-chat mode — stays non-explicit.
  // In history-restore mode: threadId={explicitThreadId}
  chatView={NangoChatViewShell}
  labels={CHAT_LABELS}
  input={NANGO_INPUT_SLOT}
/>
```

Implications:

| Aspect | Current eager-mint | chatView wrapper |
|---|---|---|
| `hasExplicitThreadId` | `true` (violates Inv-2) | `false` for fresh, `true` for history |
| Welcome screen | Never shown | Shown for fresh chats |
| Fresh-chat `/connect` | Called (404 waste) | Skipped |
| External hooks → clone B | Via store pre-fill (eager-mint) | Via `chatConfig` fallback |
| `WorkspaceProvider.useLayoutEffect` mint | Required | Removable |
| `RightPanel.ChatProviderHooks` lazy-capture | Dead code | Becomes the canonical ABC recorder (writes to store after first run) |
| Reaches into internal API | No | No (chatView slot is public) |

Verified facts (per evaluator-A review):

1. ✓ **`CopilotChatViewProps` does NOT contain `agentId`**
   (`copilotkit-DFaI4j2r.d.mts:929-980`). The shell must read `agentId`
   from `useWorkspaceStore` (or via factory closure). It receives
   `messages`, `isRunning`, `hasExplicitThreadId`, `isConnecting`,
   `onSubmitMessage`, etc. — all CopilotChat-managed state.
2. ✓ **`CopilotChatView` is a public export of
   `@copilotkit/react-core/v2`** (which is the subpath
   `src/lib/copilot/client.ts` already imports from). The v2 subpath
   barrel additionally exports `CopilotChatConfigurationProvider` and
   `useCopilotChatConfiguration`. Adding `CopilotChatView` (+
   `CopilotChatViewProps` type) to `client.ts` is a 2-line change.
3. ✓ **`ChatProviderHooks` does NOT call `useAgent`** — it subscribes
   via `copilotkit.subscribe({ onAgentRunStarted })` and then
   `event.agent.subscribe(...)`. Safe iff the run is started on
   clone B; does not need to move into the shell. Its
   `setThreadId(captured)` side-effect must be re-shaped (see
   Inv-2 / store-split below).

What still needs verification before adopting:

- **Memoisation** — `<CopilotChat>` memoises `resolvedThreadId` on
  `[providedThreadId]`; the wrapper component reference and the inner
  `messageView` object must be stable (`useMemo` + module-level constant
  or `useCallback`) to avoid extra re-renders. `MemoizedSlotWrapper`
  (`copilotkit-PzJlPKcU.mjs:107-121`) shallow-compares; an unstable
  `messageView` would defeat it.
- **Slot composition** — `<CopilotChat>` already passes
  `messageView` / `input` / `suggestionView` slot values down to
  `CopilotChatView` via `mergedProps` (line 6975-6982). Spreading
  `{...slotProps}` should NOT clobber CopilotChat-managed state
  (`messages`, `onSubmitMessage`, `isRunning`, `hasExplicitThreadId`,
  `isConnecting`). The shell should only *augment* `messageView`, not
  replace anything else.
- **Order of mount** — `useInjectHandoffContext`'s `useEffect`
  dispatches a run on first render. Inside the shell, the very first
  call to `useAgent({ agentId })` already resolves via the chatConfig
  fallback (the provider is the parent JSX, mounted before children
  in React's commit order), so `agent.threadId === ABC` synchronously.
  Worth a runtime sanity check.

### 1.11 Required prerequisite — store-split (NOT optional)

Evaluator-A's critical point: **if we move to the chatView shell but
leave `RightPanel.ChatProviderHooks` calling `setThreadId(captured)` on
the shared `workspace.threadId` field, eager-mint comes back through
the side door** — `<CopilotChat threadId={workspace.threadId}>` will
suddenly receive `ABC` after the first run finalizes, flipping
`hasExplicitThreadId` false → true and re-introducing the
`/connect` + welcome-suppression we just fixed.

So the prerequisite for adopting §1.10 is **also** to split
`workspace.threadId` into two fields with disjoint semantics:

```ts
type WorkspaceThreadState = {
  // Recorded after `onAgentRunStarted` (Inv-4). Used by history list,
  // URL sync, GET /api/threads, useThreadHydration, future restore.
  // NEVER passed to <CopilotChat>.
  runtimeThreadId: string | null;

  // Only set when user explicitly chose a stored thread (history click,
  // URL navigation). The single field that flows into
  // <CopilotChat threadId={...}>; setting it forces remount + /connect.
  explicitThreadId: string | null;
};
```

`<CopilotChat>` consumes only `explicitThreadId`. `runtimeThreadId` is
a one-way recording for downstream features (history, URL, API).

### 1.12 Recommended adoption order (per evaluator-A)

Each step in sequence, with code only changed once we agree to start:

1. Add `CopilotChatView` + `CopilotChatViewProps` to
   `src/lib/copilot/client.ts` (2-line addition).
2. Create `NangoChatViewShell` component; move `useOnRegenerate` and
   `useInjectHandoffContext` calls into it; keep `<CopilotChat>` API
   exactly as it is for now (still receives `threadId={threadId}`).
   Validate: clone B still resolved everywhere, no behaviour change.
3. Split `workspace.threadId` → `runtimeThreadId` + `explicitThreadId`.
   `ChatProviderHooks` writes to `runtimeThreadId` (one-way record).
   `ChatPanel` passes `explicitThreadId` (initially always `null`) to
   `<CopilotChat>`. Validate: fresh chat now shows welcome, no /connect.
4. Delete `WorkspaceProvider.useLayoutEffect` eager-mint.
   Validate: clone B still resolved via chatConfig fallback in the
   shell; handoff first-run lands on the correct instance.
5. Add history-restore wiring: clicking a history row sets
   `explicitThreadId = clickedId` (and remounts the chat surface).
6. Rewrite docs/comments to match the final model:
   `docs/threadid-lifecycle.md`, `ChatPanel.tsx:175-178`,
   `WorkspaceProvider.tsx:79-87`.

### 1.13 Remaining open question

**History click on the currently-active thread**: if
`runtimeThreadId === ABC` and user clicks ABC in the history list, do
we promote to `explicitThreadId = ABC` (causes remount + `/connect`
that replays the same messages we already have), or no-op? Either is
defensible — pick one when implementing Step 5.

---

## §2. Downstream message flow — to be filled in next

(Outbound submit → runtime route → runner → PersistingAgent → events →
reconstruction → CopilotKit message view)

---

## §3. HITL "flash to Welcome" bug — diagnosis & fix

> **TL;DR** — A frontend HITL tool (e.g. `ask_user_datetime`) would
> mount its picker, immediately unmount it, the chat would revert to
> the welcome screen, and the recursive runAgent feeding the user's
> selection back to the LLM would never fire. Root cause: unstable
> `{}` defaults on `<CopilotKitProvider>` props made its setter
> useEffect re-run every commit, which combined with the auto-detect
> mutation in `fetchRuntimeInfoAutoDetect` to trigger a full runtime
> reconnect — that reconnect rebuilt every remote agent from scratch,
> blanked the messages array, and tore down the picker.
> Fix: pass `Object.freeze`-d stable empty refs for the three default-
> `{}` props (`properties`, `agents__unsafe_dev_only`,
> `selfManagedAgents`). One commit: `5239310`.

### 3.1 Symptom

1. User asks Nango to "create a schedule".
2. LLM emits a frontend `ask_user_datetime` tool call.
3. DateTimePicker mounts in the chat panel for ~300 ms, then
   disappears.
4. The chat panel reverts to the welcome screen (visible messages =
   none), even though `agent.messages.length === 2` if you subscribe
   externally.
5. The HITL handler's `Promise` stays pending forever; clicking
   anywhere does nothing; no recursive `runAgent` ever fires.

The bug reproduces deterministically on CopilotKit 1.56.3 **and**
1.57.3. Upgrading the package alone does not fix it.

### 3.2 Investigation trail

Three layers of tracing pinned the trigger:

**A · `useHitlTool` lifecycle** (`frontend-tool-helpers.tsx`):
mount / cleanup / handler-invoked / respond / per-render `status`.
Showed the handler **was** invoked, the resolver **was** queued, and
the FIFO cleanup that previously was prime suspect (resolving the
Promise with `HITL_CANCELLED` on a strict-mode unmount) was **not**
triggered.

**B · `agent.messages` mutations** (`useChatFlashDebug.ts`,
`onAgentRunStarted` → per-agent `onMessagesChanged`):
`agent.messages` stayed at `len: 2` throughout. So messages were
**not** being cleared on the agent the run was attached to.

**C · the real agent CopilotChat renders from**
(`ChatViewShellBody` calling `useAgent` inside the chatView slot):
this was the smoking gun. Logging both `agent` references and
their `messages.length` showed:

```
…RUN finalized…
⚙ runtimeConnectionStatus → 'connecting'
⚙ runtimeConnectionStatus → 'connected'
[chatview] useAgent ref changed { threadId: 'NEW-UUID', messagesLen: 0 }
DateTimePicker unmount { status: 'inProgress' }
```

CopilotChat's `useAgent()` returned a **different** agent instance
the moment the runtime status flipped `connecting → connected`, and
that new instance had an empty `messages` array. The agent the
RUN was attached to (subscribed via `onAgentRunStarted`) still had
the original two messages — they just weren't visible to the UI any
more.

Adding `console.trace` to `onRuntimeConnectionStatusChanged` and
`onAgentsChanged` produced the killing stack:

```
runtimeConnectionStatus → 'connecting'
  setRuntimeTransport       (core.ts:542)
  CopilotKitProvider.tsx:644  ← provider's setter useEffect
  commitHookPassiveMountEffects
  flushPassiveEffects
```

The provider's big setter useEffect (the one that calls
`setRuntimeUrl`, `setRuntimeTransport`, `setHeaders`,
`setProperties`, `setAgents__unsafe_dev_only`) was re-running after
`RUN_FINISHED`. We had not touched any of its props.

### 3.3 Root cause

`<CopilotKitProvider>` destructures several props with `= {}`
defaults:

```ts
const CopilotKitProvider: React.FC<…> = ({
  …,
  properties = {},
  agents__unsafe_dev_only: agents = {},
  selfManagedAgents = {},
  …
}) => {
```

Each render allocates fresh empty-object references for those
locals. The provider then computes `mergedAgents` via `useMemo`:

```ts
const mergedAgents = useMemo(
  () => ({ ...agents, ...selfManagedAgents }),
  [agents, selfManagedAgents],
);
```

so `mergedAgents` gets a **new reference every render** because its
deps are unstable defaults. The setter useEffect lists `properties`
and `mergedAgents` in its deps, so it re-runs every commit:

```ts
useEffect(() => {
  copilotkit.setRuntimeUrl(chatApiEndpoint);
  copilotkit.setRuntimeTransport(useSingleEndpoint === true ? "single" : "auto");
  …
  copilotkit.setProperties(properties);
  copilotkit.setAgents__unsafe_dev_only(mergedAgents);
}, […, properties, mergedAgents, …]);
```

By itself this would be harmless — `setRuntimeTransport` short-
circuits on equal values:

```ts
setRuntimeTransport(transport) {
  if (this._runtimeTransport === transport) return;
  …
  this.updateRuntimeConnection();
}
```

**But** the very first call to `updateRuntimeConnection()` invokes
`fetchRuntimeInfoAutoDetect`, which **mutates** `_runtimeTransport`
to `"rest"` after a successful `/info` probe:

```ts
async fetchRuntimeInfoAutoDetect(…) {
  const response = await fetch(`${this.runtimeUrl}/info`, …);
  if (response.status >= 200 && response.status < 300) {
    this._runtimeTransport = "rest";    // ← !
    return await response.json();
  }
  …
}
```

After that, the dedup check `_runtimeTransport === "auto"` returns
`false` forever. Every subsequent commit fires a full runtime
reconnect:

1. Status → `"connecting"`, fetch `/info` again.
2. `remoteAgents = Object.fromEntries(...new ProxiedCopilotRuntimeAgent({…}))`
   — fresh objects, blank `messages`.
3. `this._agents = { ...localAgents, ...remoteAgents }` — new map.
4. `useAgent`'s `useMemo` deps include `copilotkit.agents` and
   `copilotkit.runtimeConnectionStatus`, so it re-runs and returns
   the new (empty) agent.
5. CopilotChat now renders that empty agent → welcome screen.
6. `ToolCallRenderer` can no longer find the assistant message
   containing the toolCall, so React unmounts the picker.
7. The HITL Promise stays pending forever.

The bug is independent of whether CopilotKit 1.56's per-thread clone
machinery is in play — 1.57 removed cloning but the registry agents
still get recreated wholesale on every reconnect.

### 3.4 Fix

`src/components/layout/RightPanel.tsx`:

```ts
const STABLE_EMPTY_AGENTS = Object.freeze({}) as Record<string, never>;
const STABLE_EMPTY_PROPS = Object.freeze({}) as Record<string, unknown>;

<CopilotKitProvider
  …
  properties={STABLE_EMPTY_PROPS}
  agents__unsafe_dev_only={STABLE_EMPTY_AGENTS}
  selfManagedAgents={STABLE_EMPTY_AGENTS}
>
```

Frozen empty refs short-circuit the chain at step (1) above: the
provider's setter useEffect deps now stay equal across commits, so
the effect never re-runs, `setRuntimeTransport` is never called
again, no reconnect fires, `remoteAgents` stay in place, `useAgent`
keeps returning the same instance, and the picker stays mounted.

### 3.5 Lessons

- **Defaults are dangerous on context provider props.** If a
  third-party provider destructures any of your props with `= {}`
  defaults, *always* pass an explicit stable ref rather than letting
  the default fire — even if your local prop reference is itself
  stable, an unrelated provider prop's default `{}` can still tank
  the deps array.
- **Mutating self-detection state inside an event that's part of a
  React effect's deps creates a one-way trap door.** The
  `fetchRuntimeInfoAutoDetect` writer is fine as an optimisation in
  isolation; it becomes a bug only when the upstream caller is a
  React effect that can re-fire.
- **The expensive instrumentation paid off.** Three independent
  trace streams (A: hook lifecycle, B: messages on the run-attached
  agent, C: messages on the chat-view-attached agent) made the
  divergence between B and C immediately visible. Without them the
  reconnect cycle would have been invisible — `RUN_FINISHED` looks
  perfectly clean if you only watch SSE events.

Fix commit: **`5239310`**. Investigation commits removed in cleanup
commit immediately after (debug logs were dev-only no-ops, no value
keeping them after fix is verified).
