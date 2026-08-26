# Shared State & Co-Editing Architecture

Status: implemented (v2) · last updated: 2026-08-26

## 1) Product Positioning

Shared state is an ambient **UX & Bidirectional CoAgent capability**, connecting the React UI state with the CopilotKit Built-in Agent (Supervisor).

### Core Goals
1. **Context Awareness**: The Agent knows where the user is, what page they are browsing (`activeView`, `activeUrl`), and what resource they are inspecting (`activeResourceId`, `activeResourceData`).
2. **Editor Registration Slot**: When an editor mounts, it registers into `useCopilotStateStore.activeEditor`, providing direct, memory-level `applyDraft` and `getCurrentData` access.
3. **Single Writer State Model**: `agent.state` holds only `context`. The `context-sync effect` in `useCopilotSharedStateSync` is the **sole writer** to `agent.state`, eliminating closure stale state and self-pollution.
4. **Interactive Co-Editing**: The Agent proposes non-destructive modifications via `propose_page_edit`; UI components preview changes and highlight the Save button in amber for user confirmation.
5. **Robust Rollback**: `discardDraft` restores from an `undoSnapshot`, resetting form values and clearing the amber highlight.

### Non-goals
- Auto-committing database mutations without user review (Write barrier).
- Generic event-sourcing / multi-master replication.
- Cross-session draft recovery.

---

## 2) Design Principles

### 2.1 Editor Registration & Direct Tool Dispatch
- When the Agent calls `propose_page_edit`, the tool handler retrieves `activeEditor` from the client Zustand store.
- The tool verifies non-emptiness, `isReadOnly` barrier, and `resourceType` alignment before directly invoking `activeEditor.applyDraft(draftData)`.
- The form is updated in React state memory, creating an `undoSnapshot` on first edit, and lighting up the Save button in amber.
- The tool handler returns the list of modified fields **without touching `agent.state`**.

```mermaid
flowchart LR
    subgraph Frontend["React UI (Editor Component)"]
        UIForm["Editor Form State"]
        SaveBtn["Save Button (Amber Highlight)"]
        Snap["Undo Snapshot"]
    end

    subgraph StateStore["Client Store (useCopilotStateStore)"]
        Reg["activeEditor (EditorRegistration)"]
        ARD["activeResourceData (150ms Debounced)"]
    end

    subgraph Agent["Supervisor Agent (LLM)"]
        Prompt["System Prompt + Ambient Context"]
        ToolCall["propose_page_edit(resourceType, draftData)"]
    end

    UIForm -->|Register on mount| Reg
    UIForm -->|150ms Debounce| ARD
    ARD -->|Context Injection (Single Writer)| Prompt
    Prompt --> ToolCall
    ToolCall -->|Direct Dispatch| Reg
    Reg -->|Backup original & apply| Snap
    Snap --> UIForm
    UIForm -->|draftApplied| SaveBtn
```

### 2.2 User Confirmation & Write Barriers (No Auto-Commit)
- `propose_page_edit` **never** executes SQL or API mutations. It only stages changes in UI form memory.
- The user must explicitly click the **Save** button (highlighted in `bg-amber-600`) to persist changes.
- **Builtin Resource Guard**: Builtin skills (`source = "builtin"`) or protected resources enforce an immediate write barrier (`isReadOnly: true`), rejecting draft applications at the tool boundary.

---

## 3) Supported Modules Matrix (9 Integrated Pages)

| Module | Route & Type | Canonical Schema | Supported Data Structures | Visual & Security Contract |
| :--- | :--- | :--- | :--- | :--- |
| **Verification** | `/verification` | `src/lib/copilot/resource-schemas.ts` | `suite` metadata + `selectedCase` (`args`, `assertions`, `description`) + `diagnostics` | Amber Save icon (`text-amber-500`) |
| **Web Auto** | `/web-auto` | `src/lib/copilot/resource-schemas.ts` | `suite` metadata + `selectedCase` (`startUrl`, `instructions`, `maxSteps`, `evaluatorPrompt`, `assertions`) | Amber Save icon (`text-amber-500`) |
| **Evaluation** | `/evaluation` | `src/lib/copilot/resource-schemas.ts` | `suite` metadata + `selectedCase` (`turns`, `rubric`, `referenceAnswer`) + `outcomes` | Amber Save icon (`text-amber-500`) |
| **Schedules** | `/schedule` | `src/lib/copilot/resource-schemas.ts` | `name`, `task`, `agentKey`, `triggerMode`, `intervalValue`, `intervalUnit`, `cronExpr`, `oneShotTime`, `timezone` | Amber Save button (`bg-amber-600`) |
| **Agents** | `/agent` | `src/lib/copilot/resource-schemas.ts` | `name`, `description`, `systemPrompt`, `model`, `temperature`, `maxSteps`, `tools` (6-category bindings: `mcp`, `skills`, `dataSources`, `sshServers`, `webAuto`, `calendars`) | Amber Save button (`bg-amber-600`) |
| **MCP Tool Test** | `/mcp` | `src/lib/copilot/resource-schemas.ts` | `server` metadata + `selectedTool` (`name`, `description`, `inputSchema`) + `args` (JSON object) + `execution` | Live `args` parameter binding |
| **Skills** | `/skills` | `src/lib/copilot/resource-schemas.ts` | `name`, `source`, `isReadOnly`, `skillMd` (YAML frontmatter + procedure) | Amber Save button + `source="builtin"` write barrier |
| **Data Sources** | `/datasource` | `src/lib/copilot/resource-schemas.ts` | `name`, `description`, `provider`, `credentialId`, `host`, `port`, `database`, `params` (Map), `readOnly`, `tableAllowlist`, `tableDenylist` | Amber Save button (`bg-amber-600`) |
| **SSH Hosts** | `/ssh-server` | `src/lib/copilot/resource-schemas.ts` | `name`, `description`, `credentialId`, `host`, `port`, `knownHostFingerprint`, `commandAllow`, `commandApprove`, `commandDeny`, `loginShell` | Amber Save button (`bg-amber-600`) |

---

## 4) State Model

Defined in `src/lib/copilot/shared-state-schema.ts`:

```ts
export interface NangoSharedState {
  /** Frontend -> Agent: Page & resource awareness */
  context: {
    activeUrl: string;
    activeView:
      | "dashboard" | "artifact" | "schedules" | "notifications"
      | "agent" | "mcp" | "skills" | "datasource" | "ssh-server"
      | "verification" | "evaluation" | "outcomes" | "profile"
      | "user" | "credential" | "config" | "trace"
      | "web-auto" | "none";
    activeResourceId: string | null;
    activeResourceData?: Record<string, unknown> | null;
  };
}
```

---

## 5) Frontend Tools & Lifecycle

Registered in `src/hooks/useCopilotSharedState.ts`:

### 5.1 `propose_page_edit`
- **Purpose**: Agent proposes field modifications to the open resource in the active editor.
- **Parameters**:
  - `resourceType`: Enum of supported resources (`"schedule" | "skills" | "agent" | "datasource" | "ssh-server" | "mcp" | "web-auto" | "verification" | "evaluation"`).
  - `draftData`: Object containing the editable fields and values to modify.
- **Safety Guards**:
  - Rejects if `draftData` is empty.
  - Rejects if no active editor is open.
  - Rejects if `resourceType` does not match active editor.
  - Rejects if target resource is marked `isReadOnly: true` (e.g. builtin skill).

### 5.2 `discard_page_edit`
- **Purpose**: Agent discards staged modifications and restores the editor to its snapshot state before edits were applied.

---

## 6) Automated Test Protection

Shared State contracts and parsing normalizations are fully guarded by automated unit tests:

1. **`tests/unit/lib/copilot/resource-registry.test.ts`**:
   - Validates all 9 active resource types matching URL prefixes and `deriveResourceType`.
2. **`tests/unit/lib/copilot/shared-state-schema-specs.test.ts`**:
   - Validates that all 9 schema specs export valid `version: "1.0"` and structured `properties`.
3. **`tests/unit/lib/copilot/draft-symmetry-parsing.test.ts`**:
   - Tests payload parsing and normalization across cases and schedules.
