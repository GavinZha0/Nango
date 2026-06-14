# Chat Flow

This document describes the design decisions and current architecture of the chat UI flow.

## 1. threadId Management (UI Side)

### 1.1 Store Split
The workspace store maintains two thread ID fields to decouple recording from the UI logic:
- `runtimeThreadId`: Recorded after `onAgentRunStarted`. Used for history lists, URL synchronization, and API lookups. This value is never passed directly to the chat component.
- `explicitThreadId`: Set only when the user explicitly chooses a stored thread (e.g. history click or URL navigation). This value flows into the chat component to trigger history restoration.

### 1.2 `chatView` Slot Wrapper
To ensure all external hooks and the UI operate on the exact same CopilotKit agent instance (avoiding a branch A/B clone discrepancy), `<CopilotChat>` wraps its children in a `CopilotChatConfigurationProvider`. Our `ChatViewShell` moves `useOnRegenerate` and `useInjectHandoffContext` inside this provider subtree so they resolve the correct thread clone.

### 1.3 Invariants
- Throughout one mounted `<CopilotChat>` session, `agent.threadId` remains stable.
- For a fresh session, `hasExplicitThreadId` remains `false` until the user explicitly switches threads.
- The agent instance subscribed by the UI and the one written to by external triggers must be the exact same object in memory.

## 2. HITL Tool Render Stability

We pass `Object.freeze`'d stable empty references to `<CopilotKitProvider>`'s defaulted props (`properties`, `agents__unsafe_dev_only`, `selfManagedAgents`).

This prevents a React effect dependency loop that would otherwise cause the chat UI to needlessly reconnect to the backend, wiping agent instances and erroneously unmounting Human-in-the-Loop (HITL) tool pickers.
