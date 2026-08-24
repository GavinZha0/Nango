# Shared State & Read-Write Symmetry Architecture

Status: implemented (v1) · last updated: 2026-08-24

## 1) Product Positioning

Shared state is an ambient **UX & Bidirectional CoAgent capability**, connecting the React UI state with the CopilotKit Built-in Agent (Supervisor).

### Core Goals
1. **Context Awareness**: The Agent knows where the user is, what page they are browsing (`activeView`, `activeUrl`), and what resource they are inspecting (`activeResourceId`, `activeResourceData`).
2. **Read-Write Symmetry**: The data structure read by the Agent (`activeResourceData`) and the draft payload accepted by `propose_page_edit` (`draftData`) are **100% structurally identical (isomorphic)**.
3. **Self-Describing Schema Contract**: `activeResourceData` embeds a standardized `_schema` specifying field types, descriptions, validation constraints, and explicit `editable: true` vs `readOnly: true` markers.
4. **Interactive Co-Editing**: The Agent proposes non-destructive modifications via `propose_page_edit`; UI components preview changes and highlight the Save button in amber for user confirmation.

### Non-goals
- Auto-committing database mutations without user review (Write barrier).
- Generic event-sourcing / multi-master replication.
- Cross-session draft recovery.

---

## 2) Design Principles

### 2.1 Read-Write Symmetry
To eliminate LLM hallucination and reduce cognitive overhead:
- When the Agent inspects the current editor, it reads `activeResourceData`.
- When the Agent calls `propose_page_edit`, the `draftData` parameter MUST follow the exact same structure defined in `activeResourceData._schema`.
- Read-only metadata (e.g. database IDs, upstream server capabilities, historical run logs, `source="builtin"`) are explicitly marked as `readOnly: true` in the schema.
- Editable form fields are marked as `editable: true`.

```mermaid
flowchart LR
    subgraph Frontend["React UI (Editor Component)"]
        UIForm["Editor Form State"]
        SaveBtn["Save Button (Amber Highlight)"]
    end

    subgraph StateStore["Zustand + CopilotKit State"]
        ARD["activeResourceData (_schema + fields)"]
        Draft["drafts[resourceType]"]
    end

    subgraph Agent["Supervisor Agent (LLM)"]
        Prompt["System Prompt + Ambient Context"]
        ToolCall["propose_page_edit(resourceType, draftData)"]
    end

    UIForm -->|getCurrentData()| ARD
    ARD -->|Context Injection| Prompt
    Prompt --> ToolCall
    ToolCall -->|Symmetric Payload| Draft
    Draft -->|applyDraft()| UIForm
    UIForm -->|draftApplied || isDirty| SaveBtn
```

### 2.2 Self-Describing Schema Specification
Every supported module provides a static, zero-runtime-cost `_schema` definition exported from `src/lib/<module>/schema-spec.ts`.

Standard Schema Metadata Format:
```json
{
  "_schema": {
    "version": "1.0",
    "resourceType": "<resource-type>",
    "description": "<Human & LLM explanation of the resource and editing rules>",
    "properties": {
      "<field>": {
        "type": "string | integer | boolean | array | object",
        "editable": true,
        "description": "..."
      },
      "<readOnlyField>": {
        "type": "string",
        "readOnly": true,
        "description": "..."
      }
    },
    "required": ["..."]
  }
}
```

### 2.3 Opt-in via `useCopilotDraft`
A page becomes editable simply by mounting the `useCopilotDraft` hook:
1. `getCurrentData()`: Produces the snapshot of `activeResourceData` (including `_schema`).
2. `applyDraft(draft)`: Receives proposed changes, normalizes types, and updates form state.
3. Provides `draftApplied` flag to highlight the Save button.

### 2.4 User Confirmation & Write Barriers (No Auto-Commit)
- `propose_page_edit` **never** executes SQL or API mutations. It only stages changes in UI form memory.
- The user must explicitly click the **Save** button (highlighted in `bg-amber-600`) to persist changes.
- **Builtin Resource Guard**: Builtin skills (`source = "builtin"`) or protected resources enforce an immediate write barrier (`isReadOnly: true`), rejecting draft applications.

---

## 3) Supported Modules Matrix (9 Symmetrically Integrated Pages)

| Module | Route | Schema Spec File | Symmetrically Supported Data Structures | Visual & Security Contract |
| :--- | :--- | :--- | :--- | :--- |
| **Verification** | `/verification` | `src/lib/verification/schema-spec.ts` | `suite` metadata + `selectedCase` (`args`, `assertions`, `description`) + `diagnostics` | Amber Save icon (`text-amber-500`) |
| **Web Auto** | `/web-auto` | `src/lib/web-auto/schema-spec.ts` | `suite` metadata + `selectedCase` (`startUrl`, `instructions`, `maxSteps`, `evaluatorPrompt`, `assertions`) | Amber Save icon (`text-amber-500`) |
| **Evaluation** | `/evaluation` | `src/lib/evaluation/schema-spec.ts` | `suite` metadata + `selectedCase` (`turns`, `rubric`, `referenceAnswer`) + `outcomes` | Amber Save icon (`text-amber-500`) |
| **Schedules** | `/schedule` | `src/lib/runner/schedule-schema-spec.ts` | `name`, `task`, `agentKey`, `triggerMode`, `intervalValue`, `intervalUnit`, `cronExpr`, `oneShotTime`, `timezone` | Amber Save button (`bg-amber-600`) |
| **Agents** | `/agent` | `src/lib/agents/schema-spec.ts` | `name`, `description`, `systemPrompt`, `model`, `temperature`, `maxSteps`, `tools` (6-category bindings: `mcp`, `skills`, `dataSources`, `sshServers`, `webAuto`, `calendars`) | Amber Save button (`bg-amber-600`) |
| **MCP Tool Test** | `/mcp/test/[id]` | `src/lib/mcp/schema-spec.ts` | `server` metadata + `selectedTool` (`name`, `description`, `inputSchema`) + `args` (JSON object) + `execution` | Live `args` parameter binding |
| **Skills** | `/skills` | `src/lib/skills/schema-spec.ts` | `name`, `source`, `isReadOnly`, `skillMd` (YAML frontmatter + procedure) | Amber Save button + `source="builtin"` write barrier |
| **Data Sources** | `/datasource` | `src/lib/data-sources/schema-spec.ts` | `name`, `description`, `provider`, `credentialId`, `host`, `port`, `database`, `params` (Map), `readOnly`, `tableAllowlist`, `tableDenylist` | Amber Save button (`bg-amber-600`) |
| **SSH Hosts** | `/ssh-server` | `src/lib/ssh/schema-spec.ts` | `name`, `description`, `credentialId`, `host`, `port`, `knownHostFingerprint`, `commandAllow`, `commandApprove`, `commandDeny`, `loginShell` | Amber Save button (`bg-amber-600`) |

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

  /** Agent -> Frontend: Staged draft proposals */
  drafts: {
    schedule?: Record<string, unknown>;
    skill?: Record<string, unknown>;
    workflow?: {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    "web-auto"?: Record<string, unknown>;
    verification?: Record<string, unknown>;
    evaluation?: Record<string, unknown>;
    agent?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
    datasource?: Record<string, unknown>;
    "ssh-server"?: Record<string, unknown>;
    [key: string]: Record<string, unknown> | undefined;
  };
}
```

---

## 5) Frontend Tools & Lifecycle

Registered in `src/hooks/useCopilotSharedState.ts`:

### 5.1 `propose_page_edit`
- **Purpose**: Agent proposes full replacement draft matching `activeResourceData._schema`.
- **Parameters**:
  - `resourceType`: Enum of supported resources (`"schedule" | "skill" | "agent" | "datasource" | "ssh-server" | "mcp" | "web-auto" | "verification" | "evaluation" | "workflow"`).
  - `draftData`: Symmetrical draft payload object.
- **Safety Guards**:
  - Rejects if `activeResourceData === null` (user is on a non-editable page).
  - Rejects if `resourceType` does not match current `activeView`.
  - Rejects if target resource is marked `isReadOnly: true` (e.g. builtin skill).

### 5.2 Lifecycle Synchronization
- **Page Navigation**: `activeResourceData` is cleared upon unmount and populated when the new editor mounts.
- **Agent Switch**: `useEffect` on `activeAgentId` immediately clears all active drafts and resets shared state.

---

## 6) Automated Test Protection

Shared State contracts and parsing normalizations are fully guarded by automated unit tests:

1. **`tests/unit/lib/copilot/shared-state-schema-specs.test.ts`**:
   - Validates that all 9 schema specs export valid `version: "1.0"`, correct `resourceType`, non-empty descriptions, and structured `properties`.
   - Validates that `defaultSharedState` and `NangoSharedState.drafts` accommodate all 9 resource types without regression.
2. **`tests/unit/lib/copilot/draft-symmetry-parsing.test.ts`**:
   - Tests symmetric payload extraction (`selectedCase`, `selectedTool.args`, schedule interval units, ISO datetimes).
   - Tests fallback tolerance for alternative Agent structure formulations.
   - Tests write-barrier security rules against immutable builtin skills.
