# A2A compatibility — `EntityDescriptor` ↔ `AgentCard` mapping

Status: **forward-compatibility notes only — Nango does not implement
A2A today**.

This document records the design decisions taken while reviewing
Google's [A2A protocol](https://github.com/google/a2a) (Agent2Agent)
in May 2026, so that whenever we choose to expose Nango agents over
A2A — or consume external A2A agents as a new backend module — we
won't have to re-derive the field mapping from scratch.

It also pairs with the analogous IBM-led
[ACP](https://github.com/ibm/acp) protocol; for this codebase we
intentionally don't track ACP separately because (a) the A2A and ACP
ecosystems are converging, and (b) IBM's BeeAI agents are already
adding A2A support, suggesting the long-term direction is a single
LF-hosted standard rooted in A2A.

---

## 1. Why this document exists

The current backend abstraction (`src/lib/backends/types.ts`) was
designed around the platforms Nango actually integrates with —
agno, Mastra, Dify. Those platforms each have their own REST shape,
and `EntityDescriptor` is a least-common-denominator projection.

A2A specifies a richer agent-discovery format (the **Agent Card**)
that — *if* the project ever decides to follow it — would let any
A2A-compliant runtime drop into Nango via a single generic adapter
instead of a hand-written per-platform module.

For now we are explicitly choosing *not* to introduce A2A. This file
exists so the next person who picks the question up has a complete
mapping table to start from rather than a blank page.

---

## 2. Mapping summary

### 2.1 Top-level fields

| A2A AgentCard field | Nango EntityDescriptor / source | Status today |
|---|---|---|
| `name` | `name` | ✅ |
| `description` | `description` | ✅ |
| `url` | derived from `credential.restUrl` + per-backend path | ⚠️ derived, not exposed |
| `version` | `version` (added 2026-05) | ✅ **mirrored** |
| `provider.organization` | `provider` (BackendId slug only) | ⚠️ partial |
| `provider.url` | — | ❌ |
| `documentationUrl` | — | ❌ |
| `iconUrl` | builtin only (`builtin_agent.icon`, emoji glyph) | ⚠️ semantically different |
| `capabilities.streaming` | implicit `true` (all bridges do SSE) | ⚠️ not explicit |
| `capabilities.pushNotifications` | partial (`delegate_async` exists for builtin path) | ⚠️ partial |
| `capabilities.stateTransitionHistory` | implicit via `entity_run` + `entity_run_event` | ⚠️ implicit |
| `securitySchemes` | Nango credential system (non-A2A shape) | ⚠️ different model |
| `security` | — | ⚠️ different model |
| `defaultInputModes` | implicit text + AG-UI parts | ❌ |
| `defaultOutputModes` | implicit text + artifact | ❌ |
| `skills[]` | counts only (`toolCount`, `skillCount`, `kbCount`) | ❌ **structural gap** |
| `supportsAuthenticatedExtendedCard` | — | ❌ (rarely used) |

### 2.2 `skills[]` — the only structural gap

A2A asks for a fully expanded array of skill objects, while
EntityDescriptor only carries integer counts. When (and only when)
we expose an A2A Agent Card endpoint, generate `skills[]` lazily
from the existing storage:

| A2A skill field | Suggested source when generating the card |
|---|---|
| `id` | `builtin_agent_tool.id` (builtin) / `mcp_tool.name` (mcp) / backend-supplied (agno/mastra/dify tools list) |
| `name` | same as above |
| `description` | tool/skill `description` |
| `tags` | new — leave empty `[]` until we add a tag column |
| `examples` | new — leave empty `[]`; could later read from `skill.prompt` first-paragraph |
| `inputModes` | default to `["text/plain"]` |
| `outputModes` | default to `["text/plain"]` |

Placement of the helper: `src/lib/backends/a2a/skill-projection.ts`
(TODO when the directory is created).

### 2.3 Nango-only fields that A2A has no slot for

| Nango field | A2A treatment | Decision |
|---|---|---|
| `kind: "agent" \| "team" \| "workflow"` | A2A models everything as `agent` | When emitting cards, map all kinds to `agent` and place the kind in an `extensions["x-nango/kind"]` block. |
| `role` | no direct slot | Concatenate into `description` end (`"<description> · Role: <role>"`) or stash in `extensions["x-nango/role"]`. |
| `prompt` | A2A intentionally hides system prompts | **Keep internal.** Never include in an outgoing card. |
| `credentialId` / `credentialName` | A2A has no multi-credential model | Internal-only. The chosen credential is implicit in *which* Nango deployment is serving the card. |
| `model: ModelInfo` | A2A hides model implementation details | **Keep internal.** Downstream A2A clients shouldn't depend on which LLM serves the agent. |
| `toolCount` / `skillCount` / `kbCount` / `memberCount` | A2A uses `skills[]` instead of counts | Used for UI only; expanded into `skills[]` when emitting an A2A card. |
| `dbId` | — | Nango-private. |
| `raw` | — | Nango-private adapter escape hatch. |

---

## 3. Implemented mirror (May 2026)

Only one field has been mirrored into `EntityDescriptor` for now:

```ts
// src/lib/backends/types.ts
export interface EntityDescriptor {
  // ...
  /** Optional version label surfaced in the agent list.
   *  Maps to A2A AgentCard.version. */
  version?: string;
}
```

Source mapping per adapter:

| Adapter | Source | Notes |
|---|---|---|
| `agno` (agent / team) | `raw.metadata.version` | User-supplied free-form field on the agno side (Python dict). Accepts string or number; empty strings and other types fall through to undefined. |
| `agno` (workflow) | `raw.current_version` → `String(...)` | Different field; agno's workflow schema versions explicitly via `current_version`. |
| `mastra` | — | Upstream doesn't expose version. |
| `dify` | — | Upstream doesn't expose version. |
| `builtin_agent` | — | (Not an EntityDescriptor consumer; built-in row uses the row's own columns and would map a future `version` column directly.) |

UI: rendered in `AgentPanel` `BackendRow` as a `v{version}` chip
matching the MCP panel's existing version chip style.

---

## 4. What we deliberately did *not* add (and why)

The following fields were considered and rejected for the May 2026
pass — adding them costs almost nothing in TypeScript but would
inflate `EntityDescriptor` with placeholders that nothing reads:

- `iconUrl` (semantics conflict with the existing builtin `icon` field)
- `documentationUrl`
- `defaultInputModes` / `defaultOutputModes`
- `capabilities.{streaming, pushNotifications, stateTransitionHistory}`
- `skills[]`
- `supportsAuthenticatedExtendedCard`

The agreement: revisit when one of the following triggers fires.

### Trigger signals for re-opening this question

1. **Any** of agno / Mastra / Dify ships a native A2A endpoint.
2. A concrete user request to add a non-listed A2A agent (e.g. a
   LangGraph workflow the customer wrote in-house and exposes as
   A2A) to Nango.
3. A strategic decision to expose the Nango supervisor as an A2A
   agent to other systems.

When that happens, the recommended path is:

1. **Don't replace** the existing backend modules. Add a new
   `src/lib/backends/a2a/` module that consumes / emits Agent Cards.
2. Extend `EntityDescriptor` with the remaining optional fields
   from §2 — type-only changes, no migration.
3. Implement `lib/backends/a2a/skill-projection.ts` for the
   `skills[]` expansion described in §2.2.
4. Expose an Agent Card endpoint (e.g.
   `/api/.well-known/agent.json?credentialId=...&agentId=...`) for
   outbound interop.

---

## 5. Source pointers

- `src/lib/backends/types.ts` — `EntityDescriptor`, `BackendCapabilities`
- `src/lib/backends/agno/entity.server.ts` — projects agno raw to
  `EntityDescriptor`; first carrier of `version`
- `src/components/left-panels/AgentPanel.tsx` — renders the
  `v{version}` chip
- `src/lib/db/schema.ts` — `builtin_agent` and `mcp_server` tables,
  the canonical storage for builtin agents & MCP tool snapshots
  that any future A2A card emitter would draw from

External:

- A2A spec: https://github.com/google/a2a
- AgentCard schema: https://github.com/google/a2a/blob/main/specification/json/AgentCard.json
- ACP (for awareness, not implementation): https://github.com/ibm/acp
