# A2A compatibility — `EntityDescriptor` ↔ `AgentCard` mapping

Status: **Forward-compatibility notes only — Nango does not implement A2A today.**

This document records the field mapping for Google's [A2A protocol](https://github.com/google/a2a). It serves as a reference for future integration, allowing Nango to either expose agents over A2A or consume external A2A agents via a generic adapter.

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
| `prompt` | A2A intentionally hides system prompts | **Keep internal.** Never include in an outgoing card. |
| `credentialId` / `credentialName` | A2A has no multi-credential model | Internal-only. The chosen credential is implicit in *which* Nango deployment is serving the card. |
| `model: ModelInfo` | A2A hides model implementation details | **Keep internal.** Downstream A2A clients shouldn't depend on which LLM serves the agent. |
| `toolCount` / `skillCount` / `kbCount` / `memberCount` | A2A uses `skills[]` instead of counts | Used for UI only; expanded into `skills[]` when emitting an A2A card. |
| `dbId` | — | Nango-private. |
| `raw` | — | Nango-private adapter escape hatch. |

---

## 3. Implemented Mirror

Currently, only the `version` field has been mirrored into `EntityDescriptor` (`src/lib/backends/types.ts`).

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

## 4. Deferred Additions & Triggers

The following fields are deferred to avoid inflating `EntityDescriptor` with unused placeholders:
- `iconUrl`, `documentationUrl`
- `defaultInputModes` / `defaultOutputModes`
- `capabilities.{streaming, pushNotifications, stateTransitionHistory}`
- `skills[]`
- `supportsAuthenticatedExtendedCard`

### Trigger signals for re-opening this integration:
1. Agno, Mastra, or Dify ships a native A2A endpoint.
2. A user needs to connect a custom A2A agent (e.g., in-house LangGraph workflow).
3. Strategic decision to expose the Nango supervisor as an A2A agent.

### Recommended Implementation Path:
1. Add a new `src/lib/backends/a2a/` module (do not replace existing backend modules).
2. Extend `EntityDescriptor` with the remaining optional fields.
3. Implement `lib/backends/a2a/skill-projection.ts` for `skills[]` expansion.
4. Expose an outbound Agent Card endpoint (e.g., `/api/.well-known/agent.json`).

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
