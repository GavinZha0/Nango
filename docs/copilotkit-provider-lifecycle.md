# CopilotKit Provider Lifecycle

> Why `<CopilotKitProvider>` lives **inside** `RightPanel` and remounts
> per agent via `key={copilotKey}`. Read this before proposing to
> "hoist it up" or "make the client tools a global singleton" — the
> current shape is load-bearing and the alternatives have costs that
> are not obvious from the call site.

---

## 1. Current shape

```tsx
// src/components/layout/RightPanel.tsx

export function RightPanel() {
  const agentId       = useWorkspaceStore((s) => s.activeAgentId);
  const agentSource   = useWorkspaceStore((s) => s.activeAgentSource);
  const credentialId  = useWorkspaceStore((s) => s.activeCredentialId);

  // Composite key. ANY field changing remounts the whole subtree.
  const copilotKey = agentId
    ? `${agentId}::${agentSource}::${credentialId ?? ""}`
    : "no-agent";

  if (!agentId) {
    return <SelectAgentPlaceholder />;       // no provider, no hooks
  }

  return (
    <CopilotKitProvider
      key={copilotKey}                       // ← the decision under discussion
      runtimeUrl={runtimeUrl}
      headers={headers}
    >
      <ChatProviderHooks />                  /* useOutcomeTools, useInteractiveTools,
                                                useHandoffTools, the
                                                wildcard renderer, lazy threadId
                                                capture */
      <ChatPanelBody />                      {/* CopilotChat */}
      <HistoryPanelBody />
    </CopilotKitProvider>
  );
}
```

Two facts about this shape:

- **Provider only mounts after an agent is selected.** Until then
  `RightPanel` renders a placeholder; no `CopilotKitCoreReact` instance
  exists and no frontend tool is registered.
- **`key={copilotKey}` forces a full subtree remount on agent /
  source / credential change.** React unmounts the old
  `CopilotKitProvider`, GCs the old `CopilotKitCoreReact` instance,
  and mounts a fresh one. All `useFrontendTool` cleanups fire, then
  the new instance re-registers the tools.

## 2. What `key={copilotKey}` actually buys

A single React idiom solves four otherwise-independent problems in
one stroke. Removing the key means replacing each row with explicit
state management.

| Problem | How the remount solves it | What you'd need without it |
|---|---|---|
| **No state bleed between agents** (messages, in-flight runs, scroll position, half-typed input, expanded tool cards) | Whole subtree re-evaluates from scratch. | Manually reset `ChatPanel` local state, call `agent.setMessages([])` on the carried-over instance, force a `<CopilotChat>` re-key, clear any per-thread Zustand slices. |
| **Welcome / empty-state re-appears for the new agent** | New `CopilotKitCoreReact` instance has no cached `messages` for the new `agentId`, so `messages.length === 0` is true and `<CopilotChat>` renders its empty UI. | Detect "agent changed → reset the per-agent `agents` Map entry" inside CopilotKit's internal store, OR conditionally pass `explicitThreadId=null` AND drop CopilotKit's cached messages for that agent. |
| **Lazy `runtimeThreadId` capture starts clean** | A fresh `onAgentRunStarted` subscriber sees the very first run for that `CopilotKitCoreReact` instance. | Track per-agent capture state explicitly in the Zustand store and reset it on agent change. |
| **In-flight HTTP / SSE / HITL Promises are abandoned** | React unmount cascade GCs the subscriber, the abort controller is released, unresolved HITL resolvers go out of scope. | For each: track the abort controller in a ref, call it on agent change; for HITL FIFO queues, reject pending resolvers with a sentinel; ensure no late-arriving SSE event lands on the new agent's UI. |

The cost of the remount itself — re-running 6 `useFrontendTool` calls
each pushing to a `_tools[]` array — is sub-millisecond. The cost of
NOT remounting is four columns of new bookkeeping code, each its own
potential bug surface.

## 3. Why a "long-lived global singleton" looks tempting but isn't

A natural-sounding alternative:

> The frontend tools are *client behaviour* — `render_chart`, HITL,
> handoff. They have nothing to do with which agent is selected. Why
> not register them once globally and let `<CopilotKitProvider>`
> outlive agent switches?

The premise is right at the conceptual layer:

- `render_chart` is registered with no `agentId` scope — it's
  globally available.
- The four `ask_*` HITL tools are registered with no `agentId` scope.
- `switch_agent_with_context` is **also** registered with no `agentId`
  scope; its supervisor-only restriction is enforced at two other
  layers (server-side `system prompt` per orchestration mode, plus a
  handler-side `resolveTarget` guard that rejects unknown agent
  names) — it does NOT rely on a React-level scoping mechanism.

So "frontend tools cross agents" is true. The flaw is at the
implementation layer: in React, the idiomatic way to scope state is
the component tree, with `key` as the explicit "reset everything"
declaration. The four bookkeeping problems above are not
"frontend-tool problems" — they're **chat-instance problems**, and
chat instances are per-agent. Making the provider long-lived to
share tool registration also implicitly shares everything else: the
client-side message cache, the connection state, the run subscribers,
the thread store. Those are not safe to share without explicit
clean-up at every transition.

The remount approach inverts this: *everything* resets together, and
the cheap re-registration of tools is a tiny cost we pay to keep the
reset idiom whole.

## 4. Why `<CopilotKitProvider>` is inside `RightPanel`, not at the page root

Hoisting the provider up to `WorkspaceProvider` (so it wraps the
entire page) is a separate temptation. Don't.

> "Previously `<CopilotKit>` wrapped the entire page tree inside
> `WorkspaceProvider`. Its key prop changed on every agent switch,
> causing React to unmount/remount the whole layout — Header,
> LeftToolbar, ThreePanelContent, and all resizable panels — which
> reset panel widths and caused a full-page flash."
> — commit `1d2ec9c`, *fix: move CopilotKit from WorkspaceProvider
>   into RightPanel*

The remount we *want* is the chat surface. The remount we *don't*
want is the chrome. Today's split honours that:

- **Inside the provider (rerenders / remounts on agent change):**
  `ChatProviderHooks`, `ChatPanelBody` (`<CopilotChat>`),
  `HistoryPanelBody`.
- **Outside the provider (stable across agent changes):**
  `RightPanelToolbar` (tab segmented control, "new chat" button,
  agent picker), the panel chrome, the resizable panel widths,
  everything in `Header` / `LeftToolbar` / `ThreePanelContent`.

`WorkspaceProvider` was deliberately demoted to "data bootstrap only"
(agent list fetch, auto-select, userId sync) and explicitly does
**not** wrap a `<CopilotKitProvider>`.

> **Doc-bug note**: `docs/backend-integration.md` still says
> "WorkspaceProvider wraps `<CopilotKitProvider>`". That sentence
> predates `1d2ec9c` and is wrong as of today. (Fixed alongside this
> doc.)

## 5. When (if ever) to revisit this decision

Trigger conditions — if any of these become real, the trade-off may
shift:

- **CopilotKit v3 (or later) lets you swap `agentId`-scoped state
  imperatively on a long-lived `CopilotKitCoreReact` instance with a
  single call (e.g. `core.activate(agentId)` that atomically resets
  messages / connection / subscribers).** Today v2's `setRuntimeUrl`
  / `setHeaders` work but per-agent state inside the core is not
  cleanly resettable; the easiest way to "switch agent state cleanly"
  is still to create a new core.
- **The frontend tool catalog grows large enough that re-registering
  it on every agent switch becomes measurable** (a frame budget
  problem, not a theoretical purity problem). Today the budget is
  ~6 tools and sub-millisecond.
- **A real cross-agent feature appears that needs shared client
  state**, e.g. a "library of in-flight HITL prompts across agents"
  affordance. Today no such feature is planned.

Until then, **leave the key**.

## 6. URL navigation contract

The provider's lifetime must outlast every route change inside the
workspace. Left-toolbar clicks navigate by URL (`/agent`, `/skills`,
`/datasource`, …) so panel state is bookmarkable and refresh-safe.
That is **only** safe because the right panel sits in
`app/(workspace)/layout.tsx`, which Next.js preserves across child
route changes — only `{children}` swaps.

To keep that guarantee, the following four invariants are
**non-negotiable**:

1. **Do not add a `usePathname()` watcher inside `RightPanel` or
   anything it imports** (`right-panels/*`, `WorkspaceProvider`,
   `useWorkspaceStore`, the chat hooks). The right panel must be
   route-agnostic.

2. **Do not call `setActiveAgent` from any `page.tsx` mount effect**
   (or any `useEffect` that fires on route change). Today the only
   callers are the `AgentSelector` dropdown and `WorkspaceProvider`'s
   first-mount fallback — both correct. A page.tsx mounting and
   setting the active agent would change `copilotKey` mid-conversation
   and blow up the in-flight chat.

3. **Keep `<CopilotKitProvider>` inside `RightPanel`** (which is
   mounted in the workspace layout). Moving it into a `page.tsx`
   would cause it to remount on every route change.

4. **Server routes that drive the chat (`/api/copilotkit/*`) must
   not read `pathname` from the client.** Today they read
   `agentId` from the URL path inside the runtime request (server
   path, not client navigation) and `credentialId` from the
   `X-Credential-Id` header — both correct.

Concretely: navigating `/` → `/agent/abc` → `/skills/xyz` →
`/datasource` does not remount the provider, does not change the
chat's active agent, does not abort in-flight runs, does not clear
messages. Only AgentSelector clicks do.

## 7. Reading list

| File | Why it matters |
|---|---|
| `src/components/layout/RightPanel.tsx` | The provider mount point + `copilotKey` definition. |
| `commit 1d2ec9c` | Original move from `WorkspaceProvider` into `RightPanel` — captures the page-flash reasoning. |
| `commit 986232b` | The `epoch` mechanism for "new chat" within the same agent (subset of the remount idiom — bumps the inner key, not the provider key). |
| `docs/threadid-lifecycle.md` | Detailed sequence of how `runtimeThreadId` is lazy-captured by `ChatProviderHooks` on the first `onAgentRunStarted` — this hook chain depends on the provider lifetime. |
| `docs/chat-flow-audit.md` §1.11 | The store-split (`runtimeThreadId` vs `explicitThreadId`) that the lazy capture relies on. |
| `docs/chat-interactive-ui.md` §3.0 | HITL handler-level cleanup — fires on `ChatProviderHooks` unmount, i.e. agent switch. The hook-level (not component-level) placement is specifically chosen so React 19 strict mode double-mount doesn't immediately cancel in-flight prompts. |
| `docs/diagrams/frontend-tool-flow.html` | The five-phase build/execute flow for frontend tools; this doc explains why Phase 1 attaches to provider mount. |
