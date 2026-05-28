# Chat Interactive UI — In-Chat Generative Components

> Status: **Implemented (Path A)** / Design only (Path B)
> Audience: full-stack engineers, frontend developers
> See also: `docs/data-visualization.md` (main panel charts),
> `docs/architecture.md` §5.4

---

## 1. Problem Statement

Agent responses are currently rendered as plain markdown text (plus
Mermaid diagrams). When an agent presents choices, follow-up questions,
or requests approval, these appear as static numbered lists or prose.
The user must type a response manually.

Goal: render **interactive UI components** inline in the chat — choice
chips, confirmation buttons, text input prompts, date/time pickers —
so the user can respond with a single click.

### Requirements

| # | Requirement |
|---|---|
| R1 | Built-in agents can present structured choices and receive the selection as a tool result |
| R2 | External agents' text-based suggestions (numbered lists, follow-up questions) are rendered as clickable elements |
| R3 | Interactive components appear inline in the chat message stream |
| R4 | After the user responds, the component transitions to a "completed" state showing the selection |
| R5 | No general-purpose "card framework" — only interactive components that collect user input |

### Scope Boundary: Interactive vs Presentational

This document covers **interactive** components only — UI that collects
user input and affects agent execution. Pure **presentational** cards
(structured display of data without interaction) are explicitly out
of scope:

- Markdown already handles structured display (tables, lists, headings,
  code blocks, emphasis).
- Existing tool renderers (`DelegateToAgentCard`, `HandoffCard`,
  planned `ChartPreviewCard`) cover action-specific status cards.
- Pure display cards add prompt complexity (LLM must decide when to
  use card vs. text) with minimal UX benefit.
- If a specific entity card is needed in the future (e.g. data source
  metadata card), add it as a single `useComponent` registration —
  no generic framework required.

---

## 2. Architecture — Dual-Entry (Same Pattern as Charts)

Like the chart dashboard (§6 of `data-visualization.md`), interactive
components use two entry paths depending on agent type, but the user
experience is visually similar.

```
┌─ Path A: Built-in Agent (IMPLEMENTED) ───────────────────────────┐
│                                                                   │
│  Agent calls one of the ask_user_* family                         │
│    (choice / confirmation / input / datetime)                     │
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

┌─ Path B: External Agent (NOT YET IMPLEMENTED) ───────────────────┐
│                                                                   │
│  Agent returns text with numbered options or follow-up questions   │
│  e.g. "I suggest:\n1. Option A\n2. Option B\nWhich do you prefer?"│
│       │                                                           │
│       ▼                                                           │
│  Custom assistantMessage renderer (on message complete)           │
│  → detectChoicePattern(message.content)                           │
│  → renders clickable chips below the message                     │
│  → user clicks chip                                               │
│  → auto-sends a new user message: "I choose: Option B"           │
│  → Agent receives the message and continues                       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Key difference**: Path A pauses the agent and returns the selection
as a structured tool result. Path B sends a new user message — the
agent doesn't "pause", it simply receives a follow-up message.

---

## 3. Path A: `useFrontendTool` + `useRenderTool` (Built-in Agents)

### 3.0 Why not `useHumanInTheLoop`?

The original design proposed CopilotKit v2's `useHumanInTheLoop` —
a wrapper around `useFrontendTool` that manages a Promise-based
handler with a `respond` callback in the render component. However,
`useHumanInTheLoop` internally calls `useFrontendTool` **with** a
`render` prop, which registers the render via
`copilotkit.addHookRenderToolCall`. Separately,
`useDefaultRenderTool("*")` registers a wildcard renderer via the
same function. **CopilotKit does NOT deduplicate** — both renderers
fire for the same tool call, producing two React elements with the
same key (the tool-call ID) and a duplicate-key console error.

**The fix**: register handler and render through **separate** hooks:

- `useFrontendTool` — handler only, **no** `render` prop
- `useRenderTool` — render only, properly overrides the wildcard

A shared `useRef` connects the two: the handler stores its Promise
`resolve` callback in the ref; the render wrapper reads it to build
the `respond` prop passed to the component. This avoids the
double-render issue while preserving the same user experience.

Additionally, the original design recommended **component-level**
`useEffect` cleanup calling `respond("__cancelled__")` on unmount.
React 19 strict mode double-mounts cause this cleanup to fire
**immediately** — resolving the Promise before the user has a chance
to interact. The implementation moves cancellation to the **hook
level** (`useInteractiveTools`), where cleanup only fires when
`ChatProviderHooks` unmounts (agent switch / CopilotKitProvider
teardown).

### 3.1 Interactive Tools

Three tools cover the structured interaction patterns. All are
registered in `src/hooks/useInteractiveTools.tsx` and called in
`ChatProviderHooks` (`src/components/layout/RightPanel.tsx`).

Free-text answers do **not** have a dedicated tool — the agent
asks in natural language and receives the reply through the main
chat input. Only structured inputs (enumerated choice, binary
approve/reject, calendar timestamp) need a render component, since
free-text would otherwise duplicate the main chat input.

#### `ask_user_choice` — Single-choice selection from a list

Schema:

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

Registration pattern (same for all three tools):

```typescript
// 1. Handler — blocks with unresolved Promise, NO render prop
useFrontendTool<ChoiceArgs>({
  name: "ask_user_choice",
  description: "Present a list of options and wait for the user to select one. ...",
  parameters: choiceSchema,
  handler: async () =>
    new Promise((resolve) => { choiceResolveRef.current = resolve; }),
});

// 2. Respond callback — resolves the Promise via shared ref
const choiceRespond = useCallback(async (value: unknown) => {
  choiceResolveRef.current?.(value);
  choiceResolveRef.current = null;
}, []);

// 3. Render — separate registration, overrides the wildcard
useRenderTool({
  name: "ask_user_choice",
  parameters: choiceSchema,
  render: (props): ReactElement => {
    const adapted = adaptRenderProps<ChoiceArgs>(
      props,
      props.status === "executing" ? choiceRespond : undefined,
    );
    return React.createElement(ChoiceSelector, adapted);
  },
});
```

Render component (`src/components/chat-interactive/ChoiceSelector.tsx`):

- **executing**: clickable option chips
- **complete**: all options preserved, selected one highlighted with
  emerald border + `Check` icon, unselected ones dimmed (opacity 50%)
- **inProgress**: skeleton placeholder

```typescript
type HitlRenderProps<T> =
  | { name: string; args: Partial<T>; status: "inProgress"; result: undefined; respond: undefined }
  | { name: string; args: T; status: "executing"; result: undefined; respond: (v: unknown) => Promise<void> }
  | { name: string; args: T; status: "complete"; result: string; respond: undefined };
```

> **Note**: `HitlRenderProps` does **not** include a `description`
> field — it was removed because `adaptRenderProps` always set it to
> `""` and no component ever read it.

#### `ask_user_confirmation` — Yes / No / Approve / Reject

Schema:

```typescript
const confirmSchema = z.object({
  message: z.string().describe("What needs confirmation"),
  confirmLabel: z.string().optional().describe("Confirm button text (default: 'Approve')"),
  rejectLabel: z.string().optional().describe("Reject button text (default: 'Reject')"),
});
```

Render component (`src/components/chat-interactive/ConfirmationButtons.tsx`):

- **executing**: Approve / Reject buttons with amber warning background
- **complete**: both labels preserved, chosen one highlighted
  (Approve → emerald + `Check`, Reject → destructive + `X`),
  other dimmed

> **Dark-mode note**: colours use shadcn/ui semantic tokens where
> available (`bg-card`, `border-border`, `bg-primary`, `bg-destructive`)
> and Tailwind `amber-500` with opacity modifiers for the confirmation
> "warning" state (the project does not define a `--warning` CSS
> variable). Opacity-based colours (`amber-500/40`, `amber-500/10`)
> work correctly under both light and dark themes.

#### `ask_user_datetime` — Date/time picker

Schema:

```typescript
const datetimeSchema = z.object({
  prompt: z.string().describe("What to ask the user, e.g. 'Select start time'"),
  mode: z.enum(["single", "range"]).optional()
    .describe("'single' for one datetime (default), 'range' for start+end"),
  defaultStart: z.string().optional().describe("Default start value as ISO 8601 string"),
  defaultEnd: z.string().optional().describe("Default end value as ISO 8601 string (range mode only)"),
});
```

Render component (`src/components/chat-interactive/DateTimePicker.tsx`):

- Uses native `<input type="datetime-local">` (zero external
  dependencies). Can be swapped for react-day-picker + shadcn
  Calendar in the future if more polish is needed.
- **single mode**: one datetime input
- **range mode**: two side-by-side inputs (Start / End) with
  `start < end` front-end validation
- **complete**: formatted datetime badges with `Calendar` + `Check`
  icons
- Uses `useId()` for label/input linkage
- Uses `[color-scheme:dark]` for native input dark mode support

### 3.2 Agent Experience

The agent uses these tools like any other — no special handling:

```
User: "Help me set up a scheduled task"
Agent:
  1. "I'll help you configure a scheduled task. What should I call it?"
     (no tool call — plain assistant message)
  User: "Daily report"
     (plain user message via the main chat input)
  2. ask_user_datetime({
       prompt: "Select the schedule",
       mode: "range",
     })
     → [start picker] [end picker]  (user selects times)
     → tool result: { start: "2026-05-12T09:00:00Z", end: "2026-05-12T17:00:00Z" }
  3. ask_user_confirmation({
       message: "Create 'Daily report' running 9:00–17:00?",
     })
     → [Approve] [Reject]  (user clicks Approve)
     → tool result: { confirmed: true }
  4. Agent continues with setup...
```

Note step 1: a free-text question is just a normal turn in the
conversation — no `useHitlTool` machinery, no pending Promise. The
LLM emits the question as assistant text and the user types the
reply in the main chat input.

### 3.3 Scoping & Edge Cases

#### `agentId` scoping

`useFrontendTool` accepts an optional `agentId` parameter to restrict
a tool's visibility to a specific agent. For the initial implementation,
interactive tools are registered **without** `agentId` — they are
available to every built-in agent. If a specific agent should NOT offer
choices (e.g. a pure-text summarizer), consider scoping individual tools
to the supervisor or specific agents.

#### Agent switch while HITL is pending

If the user switches agents while an HITL tool is waiting for a
response, the `ChatProviderHooks` component remounts and the pending
Promise will never resolve — the agent hangs.

**Mitigation — hook-level cancellation**: `useInteractiveTools`
maintains a `useRef` for each tool's pending `resolve` callback. A
single `useEffect` cleanup at the hook level cancels all pending
Promises on unmount:

```typescript
const HITL_CANCELLED = "__hitl_cancelled__";

useEffect(() => () => {
  for (const ref of [choiceResolveRef, confirmResolveRef, inputResolveRef, datetimeResolveRef]) {
    ref.current?.(HITL_CANCELLED);
    ref.current = null;
  }
}, []);
```

**Why hook-level, not component-level**: React 19 strict mode
double-mounts cause component-level `useEffect` cleanup to fire
**immediately** between the two mounts — resolving the Promise with
the cancel sentinel before the user can interact. Hook-level cleanup
only fires when `ChatProviderHooks` unmounts (which happens on agent
switch or CopilotKitProvider teardown), by which time no tool call
has been initiated yet in strict mode's initial phase.

The sentinel `__hitl_cancelled__` uses a namespaced prefix to avoid
collision with real user input. Each tool's `description` includes a
note instructing the LLM to treat it as "user declined to answer".

#### Timeout

CopilotKit does not impose a timeout on frontend tool Promises. If the
user never responds, the agent waits indefinitely. This is acceptable
for interactive tools — the user is explicitly in the loop. If a timeout
is needed in the future, wrap the Promise with `Promise.race` against a
`setTimeout`-based rejection.

#### Multiple simultaneous HITL tools

The agent may call two HITL tools in a single step (e.g.
`ask_user_choice` + `ask_user_confirmation`). CopilotKit handles this
correctly — each tool gets its own Promise. Render components appear
sequentially in the message stream in tool-call order; no special
handling needed.

#### Known limitation: duplicate-key console warning

`useFrontendTool` (even without a `render` prop) and the wildcard
`useDefaultRenderTool("*")` both register entries through
`copilotkit.addHookRenderToolCall`. CopilotKit's rendering pipeline
renders **all** matching entries, producing two React elements with
the same key (the tool-call ID). This causes a harmless console
warning: "Encountered two children with the same key". Functionality
is unaffected. To eliminate the warning, replace
`useDefaultRenderTool()` with a custom wildcard that skips HITL tool
names — this requires copying CopilotKit's internal
`DefaultToolCallRenderer` (~190 lines of inline styles).

---

## 4. Path B: Message Renderer Detection (External Agents)

> **Status**: Design only — not yet implemented. Implement when
> external agent interactive UI becomes a priority.

External agents cannot call frontend tools. Their suggestions appear
as plain text. The custom `assistantMessage` renderer detects common
patterns and converts them to clickable elements.

### 4.1 Detection Patterns

| Pattern | Example | Rendered as |
|---|---|---|
| Numbered list + question | `1. X\n2. Y\nWhich...?` | Clickable chips |
| Bullet list + question | `- X\n- Y\nWhat would you prefer?` | Clickable chips |
| Yes/No question | `Would you like to proceed?` | Yes / No buttons |
| Follow-up suggestions | `You might also want to ask:\n- ...` | Clickable suggestion chips |

### 4.2 Detection Algorithm

Detection is the riskiest part of Path B. To limit false positives,
each pattern requires **both** a structural match AND a trailing
question sentence.

```typescript
type DetectedPattern =
  | { kind: "choice"; options: string[] }
  | { kind: "yesno"; question: string }
  | { kind: "suggestions"; options: string[] };

/**
 * Numbered or bullet list whose items are short (< 120 chars).
 * The strict `$` anchor means multi-line list items (e.g. items with
 * markdown line-breaks or inline code blocks spanning lines) will NOT
 * match. This is intentional for v1 — conservative matching is
 * preferred over false positives. Collect real output samples from
 * each backend platform (Dify, Mastra, agno) and relax as needed.
 */
const LIST_ITEM_RE = /^(?:\d+[.)]\s+|[-*]\s+)(.{1,120})$/;

/** A sentence that ends with "?" and contains a choice-trigger word. */
const CHOICE_QUESTION_RE =
  /(?:which|what|choose|select|prefer|pick|would you like)\b.*\?\s*$/i;

/** A sentence that ends with "?" and starts with a yes/no trigger. */
const YESNO_RE =
  /^(?:do you|would you|should I|shall I|can I|is it|are you)\b.*\?\s*$/i;

function detectInteractivePatterns(content: string): DetectedPattern | null {
  const lines = content.split("\n").map((l) => l.trim());

  // --- Choice detection (numbered / bullet list + question) ---
  const listItems: string[] = [];
  let lastListIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = LIST_ITEM_RE.exec(lines[i]);
    if (m) { listItems.push(m[1]); lastListIdx = i; }
  }

  if (listItems.length >= 2 && listItems.length <= 5) {
    // Require a choice-triggering question within 2 lines after the list
    const tail = lines.slice(lastListIdx + 1, lastListIdx + 3).join(" ");
    if (CHOICE_QUESTION_RE.test(tail)) {
      return { kind: "choice", options: listItems };
    }
  }

  // --- Yes / No detection ---
  // Only match if the LAST non-empty line is a yes/no question
  const lastNonEmpty = [...lines].reverse().find((l) => l.length > 0) ?? "";
  if (YESNO_RE.test(lastNonEmpty)) {
    return { kind: "yesno", question: lastNonEmpty };
  }

  // --- Follow-up suggestions ---
  // "You might also want to ask:" followed by bullet items
  const suggestIdx = lines.findIndex((l) =>
    /(?:you (?:might|could|can) also|follow[- ]up|related questions)/i.test(l),
  );
  if (suggestIdx >= 0) {
    const suggestions: string[] = [];
    for (let i = suggestIdx + 1; i < lines.length; i++) {
      const m = LIST_ITEM_RE.exec(lines[i]);
      if (m) suggestions.push(m[1]);
      else if (lines[i].length > 0) break;
    }
    if (suggestions.length >= 2) {
      return { kind: "suggestions", options: suggestions };
    }
  }

  return null;
}
```

**False-positive safeguards**:

- Lists alone are NOT enough — a trailing question with a
  choice-trigger keyword is required.
- Item count is bounded (2-5) to skip long instructional lists.
- Item length is capped (120 chars) to exclude paragraph-level text.
- Yes/No detection only fires on the **last** non-empty line to avoid
  matching mid-paragraph rhetorical questions.

**Known residual false positives**: instructional numbered lists
followed by a clarifying question will still trigger detection. For
example: "1. Install the package\n2. Run setup\nWhich step would you
like me to explain further?" satisfies all structural checks. In
practice the impact is low — clicking the chip sends a reasonable
follow-up message. If this becomes a UX problem, add semantic
filtering in a later iteration (e.g. an LLM classifier, or a
negative-keyword list like "step", "instruction", "guide").

### 4.3 Integration with `AssistantMessageWithTiming`

The existing `ChatPanel.tsx` already wraps assistant messages in
`AssistantMessageWithTiming` (a `useCallback` that adds timing chips,
regeneration, etc.). Path B detection must be **merged into this
existing wrapper** — not a separate component.

> **Important**: `CopilotChatAssistantMessage` uses a **slot pattern**
> via `WithSlots`. Its `children` prop is a **render function**
> `(slotProps) => ReactNode`, NOT regular JSX children. Passing
> `<InteractiveChips />` as a JSX child would fail at the type level.
> The correct approach is to render chips **outside** the component,
> as a sibling in a wrapping `<div>`.

```typescript
// In ChatPanel.tsx — extend the existing AssistantMessageWithTiming.
// agentId and threadId are available from ChatPanelInner's props.
const AssistantMessageWithTiming = useCallback(
  (props: CopilotChatAssistantMessageProps) => {
    const { message } = props;

    // --- Path B: detect interactive patterns (only after streaming) ---
    const detected = !message.isStreaming
      ? detectInteractivePatterns(message.content)
      : null;

    return (
      // Explicit flex-col + w-full prevents this wrapper from breaking
      // CopilotKit's message list layout (which relies on parent flex/grid).
      <div className="w-full flex flex-col">
        {/* Standard assistant message + toolbar (regenerate + stubs) */}
        <CopilotChatAssistantMessage
          {...props}
          onRegenerate={onRegenerate}
          onThumbsUp={noop}
          onThumbsDown={noop}
          onReadAloud={noop}
        />
        {/* Interactive chips rendered OUTSIDE CopilotChatAssistantMessage
            (its `children` is a render function, not regular JSX children). */}
        {detected && (
          <InteractiveChips
            messageId={message.id}
            detected={detected}
            agentId={agentId}
            threadId={threadId}   // string | undefined — see §4.4
          />
        )}
      </div>
    );
  },
  [onRegenerate, agentId, threadId],
);
```

### 4.4 Render + Auto-Send

The `InteractiveChips` component handles chip rendering, disabled
state tracking, layout transition, and message dispatch.

> **State persistence across refresh**: an earlier draft used a
> module-level `Set<string>` to track clicked message IDs. This is
> volatile — `useThreadHydration` restores history on page refresh,
> but the `Set` is wiped, causing old chips to become clickable again.
> The correct approach is to infer interactivity from conversation
> context: chips are only actionable on the **last assistant message**
> in the thread. Older messages always render as disabled.

```typescript
function InteractiveChips({
  messageId,
  detected,
  agentId,
  threadId,
}: {
  messageId: string;
  detected: DetectedPattern;
  agentId: string | undefined;
  threadId: string | undefined;
}): ReactNode {
  const { copilotkit } = useCopilotKit();
  // useAgent is the project's standard way to get the active agent ref
  // (from @copilotkit/react-core/v2, re-exported via lib/copilot/client.ts).
  // v2's useAgent always returns an AbstractAgent (or throws), but we
  // add a defensive guard since threadId may be undefined on first mount.
  const { agent } = useAgent({ agentId, threadId });

  // Infer disabled state from conversation position: only the last
  // assistant message gets active chips. This survives page refresh
  // (useThreadHydration restores messages, and older ones are
  // naturally not the last).
  const isLastAssistantMessage = agent?.messages?.at(-1)?.id === messageId;
  const [clicked, setClicked] = useState(false);
  const disabled = clicked || !isLastAssistantMessage;

  const handleClick = (label: string): void => {
    if (disabled || !agent) return;
    setClicked(true);

    // Correct API: add message first, then trigger runAgent.
    // copilotkit.runAgent does NOT accept a `message` parameter.
    agent.addMessages([
      { role: "user", content: `I choose: ${label}` },
    ]);
    copilotkit.runAgent({ agent });
  };

  const options =
    detected.kind === "yesno"
      ? ["Yes", "No"]
      : detected.options;

  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap gap-2",
        // Animate-in to soften layout shift when chips appear
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
      )}
      role="group"
      aria-label="Suggested responses"
    >
      {options.map((opt) => (
        <button
          key={opt}
          className="rounded-full border border-border px-3 py-1 text-sm
                     hover:bg-accent disabled:opacity-50 disabled:cursor-default
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={disabled}
          onClick={() => handleClick(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
```

> **Layout shift**: chips appear only after streaming completes.
> The `animate-in` class (shadcn/ui animation utility) provides a
> 200ms fade + slide transition so the height change feels intentional
> rather than jarring. For further smoothing, consider wrapping in
> `<motion.div>` (framer-motion) with `layout` prop if already
> available in the project.

### 4.5 Limitations

- Detection is heuristic — may miss unusual formats or produce
  false positives despite the safeguards above. Consider adding a
  user-facing toggle to disable Path B detection if needed.
- The agent does not "pause" — clicking sends a new message. If the
  user ignores the chips and types freely, the agent handles it
  the same way.
- No structured result — the agent receives a plain text message,
  not a typed tool result.
- Different external platforms (Dify / Mastra / agno) may format
  lists differently. The regex patterns above cover the most common
  markdown-style formats; platform-specific quirks may need
  additional patterns.

---

## 5. Comparison

| Dimension | Path A (`useFrontendTool` + `useRenderTool`) | Path B (message detection) |
|---|---|---|
| Agent type | Built-in only | All agents |
| Trigger | Explicit tool call | Heuristic pattern match |
| Agent pauses | Yes — waits for tool result | No — receives new message |
| Result type | Structured (JSON) | Plain text message |
| Reliability | High (schema-validated) | Medium (detection may miss/false-positive) |
| Completed state | All options preserved, selected highlighted | Chip becomes disabled / hidden |
| Implementation | `useFrontendTool` + `useRenderTool` | Custom `assistantMessage` renderer |
| Status | **Implemented** | Design only |

---

## 6. Files

### Path A (implemented)

| File | Description |
|---|---|
| `src/hooks/useInteractiveTools.tsx` | Hook registering 3 HITL tools via `useFrontendTool` + `useRenderTool` split; hook-level cancellation |
| `src/components/chat-interactive/types.ts` | `HitlRenderProps<T>` discriminated union type |
| `src/components/chat-interactive/ChoiceSelector.tsx` | Single-choice render — chips with green check on complete |
| `src/components/chat-interactive/ConfirmationButtons.tsx` | Approve/reject render — Check/X icons on complete |
| `src/components/chat-interactive/DateTimePicker.tsx` | Date/time picker — native `datetime-local`, single/range modes |
| `src/components/layout/RightPanel.tsx` | Calls `useInteractiveTools()` in `ChatProviderHooks` |
| `src/lib/copilot/client.ts` | Exports `useFrontendTool`, `useHumanInTheLoop`, `useRenderTool` from vendor barrel |

### Path B (not yet implemented)

| File | Description |
|---|---|
| `src/lib/chat/detect-interactive-patterns.ts` | Heuristic pattern detection function (§4.2) |
| `src/components/chat-interactive/InteractiveChips.tsx` | Path B chip renderer with `isLastAssistantMessage` state (§4.4) |
| `src/components/right-panels/ChatPanel.tsx` | Merge Path B detection into `AssistantMessageWithTiming` wrapper (§4.3) |

---

## 7. Out of Scope

- **Pure presentational cards** — no general card framework. Markdown
  and existing tool renderers are sufficient. Add individual
  `useComponent` registrations if a specific entity card is needed.
- **Complex forms** — multi-field forms, file uploads. If 5+ field
  types accumulate, consider refactoring into a unified `ask_form`
  tool (see §9).
- **Persistent interactive state** — choices are ephemeral within the
  chat session. No database persistence of user selections beyond
  what `entity_run_event` already captures for tool calls.

---

## 8. Accessibility Requirements

All interactive components (Path A render components and Path B chips)
must meet the following baseline:

| Requirement | Detail |
|---|---|
| **Keyboard navigation** | All buttons and inputs must be focusable via Tab. Enter/Space must trigger click. Arrow-key cycling within a chip group (roving tabindex) is a **future enhancement** — not required for v1. |
| **ARIA roles** | Chip containers use `role="group"` with `aria-label`. Individual chips use native `<button>` (implicit `role="button"`). Text input uses `htmlFor`/`id` linkage via `useId()`. |
| **Focus management** | When an HITL tool enters "executing" state, focus should move to the first interactive element (`autoFocus`). After "complete", focus returns to the chat input. |
| **Disabled state** | Path B chips must show `aria-disabled="true"` after click. Buttons use native `disabled` attribute. |
| **Screen reader** | Completed state should announce the selection (e.g. via `aria-live="polite"` region). |

These are reflected in the implementation (`role="group"`, `aria-label`,
`focus-visible:ring`, `disabled`, `useId()`, `autoFocus`).
Implementation should verify with keyboard-only navigation and a
screen reader (VoiceOver on macOS).

---

## 9. Future: Unified Form Tool

The current approach uses individual tools per input type. If the tool
count grows beyond 5-6 or multi-field scenarios become frequent, consider
refactoring into a single `ask_form` tool:

```typescript
ask_form({
  title: "Configure scheduled task",
  fields: [
    { name: "taskName",  type: "text",     label: "Task name" },
    { name: "startAt",   type: "datetime", label: "Start time", required: true },
    { name: "endAt",     type: "datetime", label: "End time" },
    { name: "frequency", type: "choice",   label: "Repeat",
      options: [{ label: "Once", value: "once" }, { label: "Daily", value: "daily" }] },
  ]
})
```

Current individual tools would become field renderers inside the form.
This is deferred until real usage patterns confirm the need — premature
abstraction risks over-engineering the LLM parameter schema.
