# Shared State & Co-Editing Architecture

Status: Active (Production Standard) · Last Updated: 2026-08-26

## 1. Product Positioning & Core Goals

Shared State is an ambient **UX & Bidirectional CoAgent Orchestration Capability** linking the client-side React UI state with the CopilotKit Built-in Agent runtime (Supervisor / Nango).

### 1.1 Core Goals
1. **Real-time Context Awareness**: The Agent continuously perceives the user's focus, including active page view (`activeView`, `activeUrl`), open resource identifier (`activeResourceId`), and real-time form data values (`activeResourceData`).
2. **Interactive Co-Editing (Human-in-the-Loop)**: The Agent stages non-destructive form modifications via `propose_page_edit`. The UI immediately reflects changes in form state and highlights the Save button in amber (`bg-amber-600` / `text-amber-500`) for explicit human confirmation.
3. **Editor Registration Stack**: Multi-panel and nested inspector views (e.g. Test Case Inspector opened on top of a Suite Editor) register onto a FIFO `editors: EditorRegistration[]` stack. Closing child drawers automatically restores the parent editor context without orphaned state.
4. **Zod Single Source of Truth**: All 9 resource definitions are modeled as pure `.strict()` Zod schemas, dynamically deriving outbound JSON Schemas via `z.toJSONSchema()`, eliminating duplicate handwritten schema drifts.
5. **Prompt Caching & Compact Contracts**: Full resource constraints (types, allowed fields, enum values, max bounds) are statically compiled into `SHARED_STATE_PROMPT_BLOCK`, enabling zero dynamic token wastage through LLM prompt caching.
6. **Robust Reversibility**: `discardDraft` restores from a clean pre-draft baseline snapshot, resetting form fields and clearing the amber highlight.

### 1.2 Non-Goals
- Auto-committing database mutations in the background without user review (Write Barrier).
- Full distributed multi-replica state synchronization or CRDT conflict resolution.
- Cross-session offline draft recovery.

---

## 2. Architecture & Design Principles

```mermaid
flowchart TD
    subgraph UI["React UI & Form Editors"]
        EditorView["Active Editor Component"]
        DraftPreview["Form State (Live Preview)"]
        SaveBtn["Amber Save Button (Human-in-the-loop)"]
        PreDraftSnap["Pre-Draft Baseline Snapshot"]
    end

    subgraph Store["Copilot State Store (Zustand)"]
        Stack["Editor Registration Stack (EditorRegistration[])"]
        TopEditor["Active Editor Slot (Stack Top)"]
        ARD["activeResourceData (150ms Debounced)"]
    end

    subgraph Agent["Supervisor Agent Runtime"]
        SysPrompt["System Prompt + Compact Draft Contracts"]
        AmbientCtx["Agent Context (Single Writer)"]
        ToolDispatch["propose_page_edit(resourceType, draftData)"]
    end

    EditorView -->|Mount / Push| Stack
    Stack -->|Top-of-Stack| TopEditor
    EditorView -->|150ms Debounce + Sanitize| ARD
    ARD -->|Context Injection| AmbientCtx
    SysPrompt --> ToolDispatch
    AmbientCtx --> ToolDispatch

    ToolDispatch -->|Zod .strict() & Guard Checks| TopEditor
    TopEditor -->|Backup Baseline| PreDraftSnap
    TopEditor -->|Apply & Compute Real Diff| DraftPreview
    DraftPreview -->|appliedFields.length > 0| SaveBtn
```

### 2.1 Single Writer State Model
`agent.state` contains only read-only `context`. The `useCopilotSharedStateSync` hook is the **sole writer** to `agent.state`, preventing circular state mutations and closure stale state.

### 2.2 Registration Stack & Nested Drawer Safety
The Zustand store maintains an array `editors: EditorRegistration[]`.
- `activeEditor` is a derived getter returning the top of the stack (`editors[editors.length - 1] ?? null`).
- When a child modal/drawer (e.g. `CaseInspector`) mounts, it pushes to the stack.
- When closed, it unregisters, smoothly popping focus back to the parent suite editor.

### 2.3 Defense-in-Depth Sanitization (`sanitizeData`)
Before form data is serialized into `activeResourceData` or read by tool handlers, `sanitizeData` automatically strips sensitive fields (`apiKey`, `password`, `token`, `privateKey`), ensuring credentials managed in the backend never leak into LLM contexts.

### 2.4 Performance: Debounced Serialization
`useCopilotDraft` executes `getCurrentData()` and `JSON.stringify()` strictly inside a `150ms` `setTimeout` debounce timer. Render function bodies incur zero stringification overhead during rapid typing.

---

## 3. Supported Modules & Schema Matrix (9 Integrated Resources)

All schemas are defined in `src/lib/copilot/resource-schemas.ts` and registered in `src/lib/copilot/resource-registry.ts`:

| Module | Route / Type | Zod Draft Schema | Canonical Field Constraints | Visual / Security Barrier |
| :--- | :--- | :--- | :--- | :--- |
| **Schedule** | `/schedule` | `ScheduleDraftSchema` | `name` (max 120), `task` (min 1), `agentKey`, `triggerMode` (cron/interval/once), `intervalValue`, `intervalUnit`, `cronExpr`, `oneShotTime`, `timezone` | Amber Save Button (`bg-amber-600`) |
| **Skills** | `/skills` | `SkillDraftSchema` | `name`, `skillMd` (Full markdown with YAML frontmatter) | Amber Save Button + `source="builtin"` Write Barrier |
| **Agent** | `/agent` | `AgentDraftSchema` | `name`, `description`, `icon`, `model`, `modelProvider`, `credentialId`, `prompt`, `temperature` (0-1), `maxSteps` (1-50), `toolApprovalMode`, `role`, `tools` | Amber Save Button (`bg-amber-600`) |
| **Data Source** | `/datasource` | `DataSourceDraftSchema` | `name` (max 63), `description`, `provider` (postgres/mysql/mariadb/vertica), `credentialId`, `host`, `port` (1-65535), `database`, `params`, `readOnly`, `tableAllowlist`, `tableDenylist` | Amber Save Button (`bg-amber-600`) |
| **SSH Server** | `/ssh-server` | `SshServerDraftSchema` | `name` (max 63), `description`, `credentialId`, `host`, `port` (1-65535, def 22), `knownHostFingerprint`, `commandAllow`, `commandApprove`, `commandDeny`, `loginShell` | Amber Save Button (`bg-amber-600`) |
| **MCP Tool Test** | `/mcp` | `McpDraftSchema` | `selectedToolName`, `args` (JSON parameters object) | Live parameter binding |
| **Web Auto** | `/web-auto` | `WebAutoDraftSchema` | `name`, `description`, `scriptContent`, `assertions`, `selectedCase` (`name`, `description`, `scriptContent`, `assertions`) | Amber Save Icon (`text-amber-500`) |
| **Verification** | `/verification` | `VerificationDraftSchema` | `name`, `description`, `input`, `assertions`, `selectedCase` (`name`, `description`, `input`, `assertions`) | Amber Save Icon (`text-amber-500`) |
| **Evaluation** | `/evaluation` | `EvaluationDraftSchema` | `name`, `description`, `prompt`, `rubric`, `referenceAnswer`, `selectedCase` (`name`, `description`, `prompt`, `rubric`, `referenceAnswer`) | Amber Save Icon (`text-amber-500`) |

---

## 4. Tool Execution & Error Protocol

Defined in `src/lib/copilot/tool-handlers.ts` and mounted in `src/hooks/useCopilotSharedState.ts`.

### 4.1 `propose_page_edit`
- **Parameters**:
  - `resourceType`: Enum of canonical resource types (`RESOURCE_TYPES`).
  - `draftData`: Key-value object conforming strictly to the target resource draft schema.
- **Execution Pipeline & Security Guards**:
  1. **Active Editor Guard**: Rejects if no editor is registered in store (`isError: true, message: "No active resource editor is currently open..."`).
  2. **Non-Empty Guard**: Rejects empty payloads `{}` (`isError: true, message: "Draft data cannot be empty..."`).
  3. **Resource Type Alignment Guard**: Rejects if `editor.resourceType !== resourceType` (`isError: true, message: "Mismatch: current editor is viewing 'X', but draft targets 'Y'..."`).
  4. **Read-Only / Builtin Barrier**: Rejects if `editor.isReadOnly` is `true` (`isError: true, message: "Permission Denied: This resource is read-only..."`).
  5. **Zod Strict Boundary Enforcement**: Validates `draftData` against `DRAFT_SCHEMAS[resourceType].strict()`. Unrecognized fields, invalid enums, or out-of-range numbers trigger immediate rejection.
  6. **Real-Diff Application**: `editor.applyDraft` updates state and computes genuine modified fields. If no fields actually changed (`appliedFields.length === 0`), returns failure and keeps Save button unlit.
- **Success Response**:
  ```json
  {
    "status": "success",
    "resourceType": "schedule",
    "appliedFields": ["name", "task"],
    "message": "Draft applied for schedule (modified fields: name, task). UI Save button is now highlighted in amber. Please ask the user to review and click Save."
  }
  ```

### 4.2 `discard_page_edit`
- **Parameters**: `resourceType`.
- **Behavior**: Invokes `editor.discardDraft()`, applying `preDraftRef.current` back to the form state, setting `draftApplied` to `false`, and returning confirmation.

### 4.3 Standardized Error Contract
All failures across frontend tools and Supervisor delegation/schedule tools adhere to the standard shape:
```json
{
  "isError": true,
  "message": "Detailed actionable error message"
}
```

---

## 5. Automated Regression Test Net

The subsystem is guarded by a comprehensive, deterministic test net:

1. **`tests/unit/lib/copilot/resource-registry.test.ts`**:
   - Asserts registry integrity for all 9 modules, `RESOURCE_TYPES`, and dynamic URL prefix derivation.
2. **`tests/unit/lib/copilot/shared-state-schema-specs.test.ts`**:
   - Asserts that all 9 Zod-derived JSON Schema specs export valid `version: "1.0"` structures with typed properties.
3. **`tests/unit/lib/copilot/co-editing-lifecycle.test.ts`**:
   - End-to-end multi-scenario integration suite testing single writer isolation, stack pushes/pops, readonly write barriers, real diff calculations, and Zod `.strict()` constraint violations.
4. **`tests/unit/lib/copilot/tool-handler-integration.test.ts`**:
   - Headless integration suite verifying the 6 security guards and draft execution lifecycle of `executeProposePageEdit` and `executeDiscardPageEdit`.
5. **`tests/unit/lib/builtin-agents/agent-pool.test.ts`**:
   - Verifies `resolveSharedStateEnabled` default fallback rules across roles and explicit flags.
