# CopilotKit Provider Lifecycle

> Why `<CopilotKitProvider>` lives **inside** `RightPanel` and remounts
> per agent via `key={copilotKey}`. Read this before proposing to
> "hoist it up" or "make the client tools a global singleton" — the
> current shape is load-bearing and the alternatives have costs that
> are not obvious from the call site.

---

## 1. Current shape

The `CopilotKitProvider` is mounted inside `RightPanel` and uses a composite key (`copilotKey` = `agentId::agentSource::credentialId`). 
- **Deferred mount**: The provider only mounts after an agent is selected. Until then, no CopilotKitCoreReact instance exists.
- **Forced remount**: The `key` forces a full subtree remount on agent, source, or credential change. This unmounts the old provider, GCs the instance, and cleanly mounts a fresh one.

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

## 3. Why remounting is required

React's idiomatic way to scope state is the component tree, with `key` acting as the explicit "reset everything" declaration.
The chat instances are per-agent. Making the provider a long-lived global singleton to share tool registration would also implicitly share the client-side message cache, connection state, run subscribers, and thread store. These are not safe to share across agents without explicit clean-up at every transition.
The remount approach ensures everything resets together cleanly.

## 4. Why `<CopilotKitProvider>` is inside RightPanel

We want to remount the chat surface, not the entire application chrome.
- **Inside the provider (remounts on agent change):** `ChatProviderHooks`, `<CopilotChat>`, History panel.
- **Outside the provider (stable):** `RightPanelToolbar`, resizable panel widths, Header, LeftToolbar.
`WorkspaceProvider` does not wrap the chat provider to avoid full-page flashes.

## 5. Revisit Triggers

Revisit this remounting strategy only if:
- CopilotKit introduces a first-class way to atomically swap agent state (messages/connections) on a single instance.
- The frontend tool catalog grows so large that re-registration causes performance issues.
- A cross-agent feature requires shared client state.

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

