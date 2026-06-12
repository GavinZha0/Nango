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

```typescript
const choiceSchema = z.object({
  question: z.string().describe("The question to display"),
  options: z.array(z.object({
    label: z.string().describe("Display text"),
    value: z.string().describe("Value returned on selection"),
    description: z.string().optional().describe("Brief explanation"),
  })).describe("2-5 options to choose from"),
});
```

Render (`ChoiceSelector.tsx`): **executing** → clickable chips;
**complete** → selected chip highlighted (emerald border + `Check`),
others dimmed.

#### `ask_user_confirmation` — Approve / Reject

```typescript
const confirmSchema = z.object({
  message: z.string().describe("What needs confirmation"),
  confirmLabel: z.string().optional().describe("Confirm button text (default: 'Approve')"),
  rejectLabel: z.string().optional().describe("Reject button text (default: 'Reject')"),
});
```

Render (`ConfirmationButtons.tsx`): **executing** → Approve / Reject
buttons with amber warning background; **complete** → chosen button
highlighted (Approve → emerald, Reject → destructive), other dimmed.

> **Dark-mode note**: colours use shadcn/ui semantic tokens where
> available and Tailwind `amber-500` with opacity modifiers. Opacity-
> based colours work correctly under both light and dark themes.

#### `ask_user_datetime` — Date/time picker

```typescript
const datetimeSchema = z.object({
  prompt: z.string().describe("What to ask the user, e.g. 'Select start time'"),
  mode: z.enum(["single", "range"]).optional()
    .describe("'single' for one datetime (default), 'range' for start+end"),
  defaultStart: z.string().optional().describe("Default start value as ISO 8601 string"),
  defaultEnd: z.string().optional().describe("Default end value as ISO 8601 string (range mode only)"),
});
```

Render (`DateTimePicker.tsx`): native `<input type="datetime-local">`,
single or range mode. **complete** → formatted datetime badges.
Uses `useId()` for label linkage and `[color-scheme:dark]` for native
input dark mode support.

### 3.2 Shared Render Props Type

```typescript
type HitlRenderProps<T> =
  | { name: string; args: Partial<T>; status: "inProgress"; result: undefined; respond: undefined }
  | { name: string; args: T; status: "executing"; result: undefined; respond: (v: unknown) => Promise<void> }
  | { name: string; args: T; status: "complete"; result: string; respond: undefined };
```

### 3.3 Edge Cases

#### `agentId` scoping

Interactive tools are registered **without** `agentId` — available to
every built-in agent. Scope individual tools to specific agents if
needed in the future.

#### Agent switch while HITL is pending

`useInteractiveTools` maintains a `useRef` for each tool's pending
`resolve` callback. A single `useEffect` cleanup at the hook level
cancels all pending Promises on unmount with the sentinel
`"__hitl_cancelled__"`. Each tool's `description` instructs the LLM
to treat this sentinel as "user declined to answer".

Hook-level (not component-level) cleanup avoids React 19 strict-mode
double-mount resolving the Promise before user interaction.

#### Timeout

CopilotKit does not impose a timeout on frontend tool Promises. The
agent waits indefinitely — acceptable for interactive tools. Wrap with
`Promise.race` against `setTimeout` if a timeout is needed later.

#### Multiple simultaneous HITL tools

CopilotKit handles multiple concurrent HITL tool calls correctly —
each gets its own Promise. Render components appear sequentially in
tool-call order.

#### Known limitation: duplicate-key console warning

`useFrontendTool` and the wildcard `useDefaultRenderTool("*")` both
register entries through `copilotkit.addHookRenderToolCall`, producing
two React elements with the same key. This causes a harmless console
warning; functionality is unaffected. Elimination requires replacing
`useDefaultRenderTool()` with a custom wildcard that skips HITL tool
names.

---

## 4. Comparison

| Dimension | Path A (`useFrontendTool` + `useRenderTool`) | Path B (message detection) |
|---|---|---|
| Agent type | Built-in only | All agents |
| Trigger | Explicit tool call | Heuristic pattern match |
| Agent pauses | Yes — waits for tool result | No — receives new message |
| Result type | Structured (JSON) | Plain text message |
| Reliability | High (schema-validated) | Medium (detection may miss/false-positive) |
| Completed state | All options preserved, selected highlighted | Chip becomes disabled / hidden |
| Implementation | `useFrontendTool` + `useRenderTool` | Custom `assistantMessage` renderer |
| Status | **Shipped** | Not implemented |

---

## 5. Files

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

## 6. Out of Scope

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

## 7. Accessibility Requirements

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
