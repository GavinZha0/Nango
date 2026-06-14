# Chat Interactive UI — In-Chat Generative Components

> Status: **Shipped (Path A)**
> Audience: full-stack engineers, frontend developers
> See also: `docs/data-visualization.md` (main panel charts),
> `docs/architecture.md` §5.4

---

## 1. Problem Statement

Agent responses are plain markdown. When an agent presents choices or
requests approval, the user must type a response manually. This document
describes the **interactive UI components** rendered inline in chat —
choice chips, confirmation buttons, date/time pickers — so the user can
respond with a single click. Only interactive (input-collecting)
components are in scope; pure presentational cards are not.

---

## 2. Architecture

Built-in agents use CopilotKit frontend tools to pause the agent,
render an interactive component, and return the user's selection as a
structured tool result.

```
┌─ Built-in Agent ─────────────────────────────────────────────────┐
│                                                                   │
│  Agent calls one of the ask_user_* family                         │
│    (choice / confirmation / datetime)                             │
│       │                                                           │
│       ▼                                                           │
│  CopilotKit routes tool call to browser                           │
│  → handler returns Promise (does NOT resolve yet)                 │
│  → useRenderTool renders interactive UI (status: "executing")     │
│  → user clicks                                                    │
│  → respond(selection) resolves the Promise via shared ref         │
│  → tool result returns to Agent                                   │
│  → Agent continues with the user's choice                         │
│  → render shows completed state (status: "complete")              │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 3. Interactive Tools (Path A)

### 3.0 Why not `useHumanInTheLoop`?

`useHumanInTheLoop` internally calls `useFrontendTool` **with** a
`render` prop, which conflicts with `useDefaultRenderTool("*")` —
both fire for the same tool call, producing duplicate-key React
elements. The fix: register handler and render through **separate**
hooks (`useFrontendTool` handler-only + `useRenderTool` render-only)
connected by a shared `useRef` for the Promise `resolve` callback.

Cancellation lives at the **hook level** (`useInteractiveTools`), not
component level, to avoid React 19 strict-mode double-mount firing
cleanup immediately.

### 3.1 Tool Signatures

Three tools are registered in `src/hooks/useInteractiveTools.tsx` and
called in `ChatProviderHooks`. Free-text answers use the main chat
input — no dedicated tool.

#### `ask_user_choice` — Single-choice selection

| Property | Type | Description |
|---|---|---|
| `question` | string | The question to display |
| `options` | array | 2-5 options to choose from |
| `options[].label` | string | Display text |
| `options[].value` | string | Value returned on selection |
| `options[].description` | string | Brief explanation (optional) |

Render (`ChoiceSelector.tsx`): **executing** → clickable chips; **complete** → selected chip highlighted.

#### `ask_user_confirmation` — Approve / Reject

| Property | Type | Description |
|---|---|---|
| `message` | string | What needs confirmation |
| `confirmLabel` | string | Confirm button text (default: 'Approve') |
| `rejectLabel` | string | Reject button text (default: 'Reject') |

Render (`ConfirmationButtons.tsx`): **executing** → Approve / Reject buttons; **complete** → chosen button highlighted.

#### `ask_user_datetime` — Date/time picker

| Property | Type | Description |
|---|---|---|
| `prompt` | string | What to ask the user, e.g. 'Select start time' |
| `mode` | string | 'single' (default) or 'range' |
| `defaultStart` | string | Default start value as ISO 8601 string (optional) |
| `defaultEnd` | string | Default end value (range mode only) (optional) |

Render (`DateTimePicker.tsx`): native `<input type="datetime-local">`.

### 3.2 Shared Render States

| Status | Render Behavior |
|---|---|
| `inProgress` | Tool call is streaming in. |
| `executing` | UI component is active and waiting for user input. |
| `complete` | User has interacted, tool result returned, UI is static. |

---

## 4. Files

| File | Description |
|---|---|
| `src/hooks/useInteractiveTools.tsx` | Hook registering 3 HITL tools via `useFrontendTool` + `useRenderTool` split; hook-level cancellation |
| `src/components/chat-interactive/types.ts` | `HitlRenderProps<T>` discriminated union type |
| `src/components/chat-interactive/ChoiceSelector.tsx` | Single-choice render — chips with green check on complete |
| `src/components/chat-interactive/ConfirmationButtons.tsx` | Approve/reject render — Check/X icons on complete |
| `src/components/chat-interactive/DateTimePicker.tsx` | Date/time picker — native `datetime-local`, single/range modes |
| `src/components/layout/RightPanel.tsx` | Calls `useInteractiveTools()` in `ChatProviderHooks` |
| `src/lib/copilot/client.ts` | Exports `useFrontendTool`, `useHumanInTheLoop`, `useRenderTool` from vendor barrel |

---

## 5. Out of Scope

- **Pure presentational cards** — no general card framework. Markdown
  and existing tool renderers are sufficient. Add individual
  `useComponent` registrations if a specific entity card is needed.
- **Complex forms** — multi-field forms, file uploads. If 5+ field
  types accumulate, consider refactoring into a unified `ask_form`
  tool.
- **Persistent interactive state** — choices are ephemeral within the
  chat session. No database persistence of user selections beyond
  what `entity_run_event` already captures for tool calls.

---

## 6. Accessibility Requirements

All interactive components must meet the following baseline:

| Requirement | Detail |
|---|---|
| **Keyboard navigation** | All buttons and inputs must be focusable via Tab. Enter/Space must trigger click. Arrow-key cycling within a chip group (roving tabindex) is a **future enhancement** — not required for v1. |
| **ARIA roles** | Chip containers use `role="group"` with `aria-label`. Individual chips use native `<button>` (implicit `role="button"`). Text input uses `htmlFor`/`id` linkage via `useId()`. |
| **Focus management** | When an HITL tool enters "executing" state, focus should move to the first interactive element (`autoFocus`). After "complete", focus returns to the chat input. |
| **Disabled state** | Buttons use native `disabled` attribute. |
| **Screen reader** | Completed state should announce the selection (e.g. via `aria-live="polite"` region). |

These are reflected in the implementation (`role="group"`, `aria-label`,
`focus-visible:ring`, `disabled`, `useId()`, `autoFocus`).
Implementation should verify with keyboard-only navigation and a
screen reader (VoiceOver on macOS).
