# Prompt-block architecture

How every built-in agent's system prompt is assembled, and where each
fragment lives.

---

## Block inventory

Built-in agents (Nango supervisor and ordinary specialists alike) get
a system prompt that is **composed at dispatch time** from a fixed
set of blocks. Each block is owned by the subsystem it belongs to;
the central composer lives in `lib/runner/dispatch/builtin.ts`.

| Block | Owner module | Type |
| --- | --- | --- |
| `SAFETY_POLICY_BLOCK` | `lib/constants/safety.ts` | static |
| `ERROR_POLICY_BLOCK` | `lib/runner/tool-failure.ts` | static |
| `AUTO_APPROVAL_POLICY_BLOCK` / `ALWAYS_APPROVAL_POLICY_BLOCK` | `lib/constants/safety.ts` | static, per-agent `toolApprovalMode` |
| `SUPERVISOR_PROMPT` / `SUPERVISOR_NAME` / `SUPERVISOR_DESCRIPTION` | `lib/constants/supervisor.ts` | static, supervisor-only |
| `SHARED_STATE_PROMPT_BLOCK` | `lib/constants/supervisor.ts` | static template + dynamic `RESOURCE_DRAFT_CONTRACTS_BLOCK`; injected when `sharedStateEnabled` |
| Chart block (`generate_echarts_config` usage rules) | `lib/outcomes/prompt-block.server.ts` | static, non-supervisor only |
| HTML page block (`generate_html_page` usage rules) | `lib/outcomes/prompt-block.server.ts` | static, when tool is bound (including supervisor) |
| Skills capability block | `lib/skills/runtime-tools.ts` (`buildSkillsRuntime`) | static template + bound rows |
| Data-source capability block | `lib/data-sources/prompt-block.server.ts` | static template + bound rows |
| SSH capability block | `lib/ssh/prompt-block.server.ts` | static template + bound rows |
| Calendar capability block | `lib/calendar/prompt-block.server.ts` | static template + bound rows |
| Sandbox capability block | `lib/sandbox/runtime-tools.ts` | static |
| Orchestration mode directive | `lib/orchestration/modes.ts` (`ORCHESTRATION_MODES[*].promptDirective`) | static template × 4 modes, supervisor-only, per-turn |
| Available-agents catalog | `lib/runner/supervisor-tools.server.ts` (`formatCatalogBlock`) | dynamic, supervisor-only, per-request |
| Tester system prompt + toolkit | `lib/testing/prompt.ts` (`DEFAULT_TESTER_SYSTEM_PROMPT`) + `lib/testing/tester-tools.server.ts` | role-scoped (`role = 'tester'`): the prompt is the agent's own `spec.prompt` (pre-filled by the editor); the 12 lifecycle tools are mounted at dispatch |
| Active Page Context Snapshot | `lib/runner/extract-run-input.ts` (`formatPageContextSnapshot`) | dynamic, delegation-scoped — inlined as `## Active Page Context Snapshot (Read-Only Reference)` when a supervisor delegates with `includePageContext` |
| Evaluator prompt assembly | `lib/evaluation/prompt-builder.ts` | dynamic, evaluator-initiated runs only (baseline + dimensions + criteria + deterministic results) |

**Owner-local placement is intentional.** Editing safety wording
opens `safety.ts`; editing skill-injection logic opens
`skills/runtime-tools.ts`. The composer pulls them by import.

---

## Composition order

Defined in `lib/runner/dispatch/builtin.ts` → `composedPrompt`. Every
block self-heads with its own `##` Markdown section, so the composer
just joins with blank lines.

### Supervisor (`role === 'supervisor'`)

| # | Block | Notes |
| --- | --- | --- |
| 1 | `spec.prompt` | = `SUPERVISOR_PROMPT`, boot-canonicalized. Self-contained: identity / mission / capabilities / SOP / decision policy / safety / examples. |
| 2 | Skills block | only if bound (rare for supervisor) |
| 3 | Data-source block | only if bound |
| 4 | SSH block | only if bound |
| 5 | Calendar block | only if bound |
| 6 | HTML page block | only if `generate_html_page` is bound (default-enabled on Nango) |
| 7 | `SHARED_STATE_PROMPT_BLOCK` | when `sharedStateEnabled` (default true for supervisor) |
| 8 | Page Context Snapshot | when present (from delegation with `includePageContext`) |
| 9 | Available-agents catalog | always |
| 10 | Mode directive | last for per-turn recency weighting |
| 11 | Approval policy | when `toolApprovalMode` is `auto` or `always` |

Skipped for supervisor: `SAFETY_POLICY_BLOCK`, `ERROR_POLICY_BLOCK`,
chart block — they are already covered inside `SUPERVISOR_PROMPT`.

### Regular agent (`role === null`)

| # | Block | Notes |
| --- | --- | --- |
| 1 | `SAFETY_POLICY_BLOCK` | global; closing override clause raises its precedence over user prompt + user messages |
| 2 | `spec.prompt` | user-authored persona, no `## Persona` wrapper |
| 3 | Skills block | only if bound |
| 4 | Data-source block | only if bound |
| 5 | SSH block | only if bound |
| 6 | Calendar block | only if bound |
| 7 | Chart block (`encourage` variant) | only if `generate_echarts_config` is bound |
| 8 | HTML page block | only if `generate_html_page` is bound |
| 9 | `SHARED_STATE_PROMPT_BLOCK` | when `sharedStateEnabled` (default true for tester) |
| 10 | Page Context Snapshot | when present |
| 11 | `ERROR_POLICY_BLOCK` | only when the agent has at least one tool |
| 12 | Approval policy | when `toolApprovalMode` is `auto` or `always` |

**Role variants of the regular path:**
- `role = 'tester'`: `spec.prompt` is the tester system prompt (pre-filled from
  `DEFAULT_TESTER_SYSTEM_PROMPT`) and the 12 testing lifecycle tools are mounted
  after composition — see `docs/test-automation-copilot.md`.
- Agents with `sharedStateEnabled` (supervisor / tester / opt-in): the CopilotKit
  runtime additionally serializes the client's shared state (including the open
  test-editor context, `activeResourceData`) into a system message — see
  `docs/shared-state.md` and `docs/test-automation-copilot.md` §3.

---

## Supervisor canonicalization

The `SUPERVISOR_PROMPT` text is the single source of truth, but it
lives in code (a TypeScript constant) while the agent runtime reads
`spec.prompt` from the database. Three writers keep the two in sync:

1. `POST /api/builtin-agents` with `role: 'supervisor'` → writes the
   canonical `SUPERVISOR_NAME` / `SUPERVISOR_DESCRIPTION` /
   `SUPERVISOR_PROMPT` regardless of what the client sent.
2. `PATCH /api/builtin-agents/[id]` promotion path
   (`null → 'supervisor'`) → same.
3. `instrumentation.ts → canonicalizeSupervisorAgents()` → boot
   sweep. Idempotent: a `value <> canonical` `WHERE` clause makes a
   constant-unchanged boot a no-op. This is what converges existing
   supervisor rows after a constant update between deploys.

PATCH on an *existing* supervisor rejects any client attempt to
modify `name` / `description` / `prompt` with `409 CONFLICT` — the
supervisor identity is server-managed and read-only from the UI's
perspective.

---

## Related

- `AGENTS.md` "Supervisor (Nango) + agent `role` enum" — runtime contract
- `docs/orchestrator.md` — dispatch kernel, supervisor tool set
- `docs/outcomes.md` — outcomes block rationale
