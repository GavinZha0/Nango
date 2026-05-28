# Memory Layer (mem0) — Proposal

> **Status: NOT IMPLEMENTED.** This document captures the design and
> rationale for adding cross-session memory to BuiltIn agents via mem0.
> Nothing in `src/` references mem0 yet; the actual integration will
> only happen when product needs justify it (see §9).

---

## 1. Why a memory layer

A single chat thread already has full message history; CopilotKit
runtime keeps that buffer for the lifetime of the thread. What it
**cannot** do:

- Remember anything about the user across threads. Each new "New chat"
  starts at zero context.
- Remember facts after a thread is archived or deleted.
- Carry user preferences across BuiltIn agents (the same user talking
  to "Sales Analyst" and "Code Helper" today is two strangers).

Memory is the layer that turns a stateless chat surface into one that
**accumulates context** across sessions for the same user. Without it,
the user pays the same onboarding cost on every conversation.

> Reading: Anthropic's [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
> distinguishes in-context, external, and procedural memory; mem0 is
> the **external semantic** layer.

---

## 2. Scope

Same boundary-design rule we already applied to observability — do not
duplicate what backends already own.

| Agent type | Existing memory | Adds mem0? |
|---|---|---|
| agno backend | session DB (PostgreSQL) + memory + KB (PgVector) | ❌ leave alone |
| Mastra backend | memory thread + RAG | ❌ leave alone |
| Dify backend | conversation memory + Knowledge | ❌ leave alone |
| **BuiltIn agent** (CopilotKit runtime) | only in-thread message buffer | ✅ **target scope** |

mem0 is therefore a BuiltIn-only feature. This mirrors the Langfuse
scope decision in `docs/observability.md`.

---

## 3. Why mem0 (vs Letta, Zep, DIY)

| Option | Integration cost | Self-host | Auto-extracts facts | Architectural weight |
|---|---|---|---|---|
| **mem0** | low (drop-in API) | yes (Postgres + pgvector) | yes | low |
| Letta (MemGPT) | medium (separate service) | yes | yes; three-tier core/archival/recall | high |
| Zep | medium (separate service) | yes | yes; summary + entity extraction | medium |
| DIY pgvector + extraction pipeline | high | yes | self-built | high |

### Why mem0 fits Nango

1. **Matches the BuiltIn agent's "lightweight, configured-then-run"
   posture.** Letta's three-tier engineered architecture would inflate
   complexity for an agent surface that is, by design, not built for
   long-running tasks.
2. **Reuses our Postgres**. mem0 self-hosted talks to Postgres + pgvector,
   which we already provision via Drizzle. No new datastore to operate.
3. **Tiny API surface**: `memory.add(...)`, `memory.search(...)`. We can
   wrap the whole thing behind one module the same way we wrapped
   Langfuse behind `langfuse.ts`.
4. **Production-validated**: AWS Agent SDK adopts mem0 as its
   exclusive memory provider — not a research toy.
5. **First-class TypeScript SDK** — no cross-language bridging.

### What to watch out for

- **TS SDK feature parity** with the Python SDK has historically lagged.
  Verify before committing (see §8).
- **Auto-extraction LLM cost** — every conversation runs through an
  extractor LLM. Linear with message volume.
- **Extraction quality** — occasionally promotes noise to "fact". Needs
  ongoing quality monitoring.
- **GDPR / privacy** — auto-extracted facts may include PII. The user
  must be able to inspect and delete their memories. Day-0 requirement,
  not a later phase.

---

## 4. What kind of memory does Nango need

Three distinct kinds, with different storage strategies:

| Kind | Example | Origin |
|---|---|---|
| **Semantic** | "user prefers Python", "user works in fintech" | extracted from conversation |
| **Episodic** | "we discussed the Q3 sales dashboard last Tuesday" | conversation history across threads |
| **Procedural** | "always reply in Chinese", "include code comments" | explicit user / admin declaration |

What goes where:

- **Semantic** → mem0 (its primary value proposition). Highest payoff
  for BuiltIn agents.
- **Episodic** → optional / later phase. Don't duplicate what CopilotKit
  already keeps in-thread; episodic only adds value when crossing thread
  boundaries (e.g. "remember what we agreed in another session").
- **Procedural** → keep on the BuiltIn agent's existing `prompt` field
  (already in DB). **Do not** push procedural rules into mem0 — they
  are admin-defined, shared across users, and should never be subject
  to auto-extraction.

---

## 5. Architecture

### 5.1 Run-time flow

```
┌──────────────────────────────────────────────────────┐
│           BuiltIn Agent Run (/agent/<id>/run)        │
│                                                      │
│   Request (user message)                             │
│        │                                             │
│        ▼                                             │
│   ┌──────────────────────────────────┐               │
│   │ Memory Pre-Hook                  │               │
│   │   mem0.search(userId, agentId,   │               │
│   │     query=lastMessage)           │               │
│   │   → top N relevant facts         │               │
│   └──────────────────────────────────┘               │
│        │                                             │
│        ▼ inject into system context                  │
│   ┌──────────────────────────────────┐               │
│   │ CopilotKit runtime → LLM         │               │
│   │   System: "<original prompt> +   │               │
│   │            <relevant memories>"  │               │
│   └──────────────────────────────────┘               │
│        │                                             │
│        ▼ AG-UI stream out                            │
│   ┌──────────────────────────────────┐               │
│   │ Memory Post-Hook (async)         │               │
│   │   mem0.add(userId, agentId,      │               │
│   │     conversation=[user, agent])  │               │
│   │   → mem0 LLM extracts facts      │               │
│   └──────────────────────────────────┘               │
│        │                                             │
│        ▼                                             │
│   Response back to browser                           │
└──────────────────────────────────────────────────────┘
```

### 5.2 The integration point on the Nango side

Two viable strategies, ordered by elegance:

#### Strategy A — CopilotKit runtime middleware (preferred)

If CopilotKit v2 runtime exposes `before_model` / `after_model` hooks
or an `LLMAdapter` injection point, we attach the memory hooks there.
Code lives in the route handler at
`src/app/api/copilotkit/builtin/[...path]/route.ts` (where `BuiltInAgent`
instances are constructed per request from the AgentSpec pool).

**Pros**: hooks fire exactly once per LLM call; we have access to the
full message array; runtime owns concurrency.

**Cons**: tied to CopilotKit's internal API; could break across
upgrades.

#### Strategy B — HTTP boundary interception (fallback)

If CopilotKit has no extension point, do the same thing the Langfuse
integration does today: intercept the request/response in
`/api/copilotkit/builtin/[...path]/route.ts`.

- On `/agent/<id>/run` POST, clone the body, read `messages[-1]`, run
  `mem0.search`, prepend results to the body's `messages[0]` system
  message before forwarding to the runtime.
- Wrap the response stream with a `TransformStream` that accumulates
  the assistant's final text (already needed for Phase 2-A of the
  observability roadmap), and call `mem0.add` once `RUN_FINISHED` lands.

**Pros**: zero CopilotKit-internal coupling; survives any runtime
upgrade.

**Cons**: more code; we're parsing AG-UI events on the server. (We
already have one such parser in `mastra.chat.ts` — refactor it before
adding a second consumer.)

**Decision rule**: open `node_modules/@copilotkit/runtime/v2/...` and
look for middleware support **before** writing any code. Strategy A is
preferred when feasible; otherwise Strategy B.

### 5.3 Data isolation

Memory is keyed by `(userId, agentId)`. Both must be filterable to:

- Prevent user A's memories ever leaking into user B's responses
  (security-critical).
- Prevent "Code Helper" memories polluting "Sales Analyst" answers
  (quality-critical, user-trust-critical).

mem0 supports per-record `metadata` plus query-time filters. We use:

```ts
// On add:
memory.add({ messages, userId, metadata: { agentId, source: "builtin" } });

// On search:
memory.search({ query, userId, filters: { agentId } });
```

`agentId` filtering is opt-out by design: in a future phase we may let
admins flag a BuiltIn agent as "shared memory pool" so a user's facts
flow across agents — but the **default must be agent-scoped**.

### 5.4 Where mem0 sits relative to other context

```
[builtin_agent.prompt]               ← admin-configured procedural memory
                                       (shared across all users of this agent)
   +
[mem0 memories for (user, agent)]    ← auto-extracted semantic memory
                                       (user-private)
   +
[in-thread message history]          ← CopilotKit runtime, this run only
   ↓
=  Complete system context for one LLM call
```

**Do not collapse layers.** Each has different lifetime, ownership, and
visibility rules.

---

## 6. Reuse from the Langfuse work

The observability layer we already shipped (`docs/observability.md`)
gives mem0 most of its scaffolding for free. The expected build cost is
roughly **60% of the Langfuse work** because the patterns are reusable.

| Langfuse pattern | mem0 reuse |
|---|---|
| `keypair` / `api_key` credential types | mem0 self-host: `api_key` (just one LLM key for the extractor). mem0 cloud: `api_key` for the mem0 service key. |
| `serviceType: "observability"` | Add a parallel `serviceType: "memory"`. Same trivial schema extension. |
| Provider registry | Add `{ value: "mem0", label: "mem0", service: "memory" }`. |
| `langfuse.ts` lazy singleton + three-state cache | Copy structure to `src/lib/memory/mem0.ts`. |
| `getEnabledObservabilityCredential()` | Add a sibling `getEnabledMemoryCredential()` returning `{ host, apiKey, embeddingModel?, ... }`. |
| `onCredentialCacheInvalidated` subscription | mem0 client self-registers; key rotation rebuilds the client on the next request, no restart. |
| `NANGO_OBSERVABILITY_TARGETS` env switch | Add `NANGO_MEMORY_TARGETS` with values like `read,write` so an operator can disable writes (no new memories) while keeping reads (use existing memories) — useful when triaging extraction-quality issues. |

The `memory` service type and `getCredentialFieldsById` already work
without changes; we only add labels in the admin table and provider
registry.

---

## 7. Phased roadmap

> All phases are deferred until product justifies it (see §9). The
> sizing below assumes one engineer working uninterrupted.

### Phase 1 — Minimum viable (1–2 weeks)

Goal: a BuiltIn agent recognises a user across sessions for facts they
explicitly volunteered (e.g. "I prefer Python").

- [ ] Schema: add `"memory"` to `CredentialServiceType` union and Zod enums.
- [ ] Provider registry: add `mem0`.
- [ ] Admin UI: trivially picks up the new type via existing labels.
- [ ] Dependency: `pnpm add mem0ai` (verify package name during the
      open-questions audit).
- [ ] Module: `src/lib/memory/mem0.ts` (singleton, mirror `langfuse.ts`).
- [ ] Module: `src/lib/memory/hooks.ts` exporting
      `searchMemoriesForRun(ctx)` and `recordRunMemories(ctx, result)`.
- [ ] Integration: Strategy A or B per §5.2, gated by feasibility audit.
- [ ] Env switch: `NANGO_MEMORY_TARGETS=read,write` (default both).
- [ ] **Day-0 privacy**: route `DELETE /api/memory/me` that deletes all
      memories for the requesting user. Required before going to
      production — not "later".
- [ ] Observability: every `mem0.add` / `mem0.search` call adds a child
      span on the active Langfuse trace (this is exactly the
      `proxy_errors`-target child-span pattern, just with `target:
      "builtin"`).

#### Acceptance test

1. User says "I'm working in TypeScript today" mid-conversation.
2. Close all tabs, return tomorrow, click **New chat** on the same
   BuiltIn agent.
3. With no further prompting the agent uses TypeScript-flavoured
   examples.
4. Admin can find the `"prefers TypeScript"` memory in the mem0
   dashboard or the underlying Postgres table, scoped to that user
   and that agent.

### Phase 2 — User control + transparency (about 1 week)

mem0 auto-extraction is opaque by default; users do not know what the
agent has stored about them. Long-term that is a legal and trust risk.

- [ ] User-facing memory page: list memories for the signed-in user,
      grouped by agent. Each row deletable.
- [ ] Admin override: admin can browse all users' memories (useful for
      complaints / legal requests) but every read is logged.
- [ ] Memory categorisation tag (`preference` / `fact` / `interaction`)
      surfaced on the UI for sense-making.
- [ ] Cascade delete: deleting a user account purges that user's
      memories. Wire into the existing better-auth account-deletion
      flow.

### Phase 3 — Quality + scale (open-ended)

Pick from these as business needs appear:

- [ ] Quality monitoring: sample 1% of mem0 extractions, run
      LLM-as-judge to flag garbage facts. Daily report.
- [ ] Cross-agent shared memory: opt-in flag on `builtin_agent` table —
      when true, search ignores `agentId` filter so memories flow across
      agents for the same user.
- [ ] Memory expiry / decay: time-weighted scoring so 6-month-old
      "preferences" get demoted by recent contradicting facts.
- [ ] Hierarchical memory: if BuiltIn evolves toward genuinely
      long-running personal-assistant use cases, evaluate Letta-style
      core/archival/recall as a successor architecture. mem0 → Letta is
      a one-way migration, plan for it deliberately.

---

## 8. Open questions to answer before starting

| # | Question | How to answer |
|---|---|---|
| 1 | **TS SDK feature parity** | Read https://github.com/mem0ai/mem0 TypeScript SDK README and recent changelog. Specifically check: filter support on retrieve, metadata typing, self-hosted vector store config, async batch operations. |
| 2 | **mem0 self-host with PostgreSQL + pgvector only** | Inspect mem0's `vector_stores` config. Goal: avoid pulling in Qdrant / Chroma / Pinecone. Should be just our existing Postgres. |
| 3 | **CopilotKit v2 runtime middleware availability** | Read `node_modules/@copilotkit/runtime/v2` source for `before_model`, `after_model`, `LLMAdapter`, or interceptor APIs. Decides Strategy A vs B in §5.2. |
| 4 | **Extractor LLM credential** | mem0 needs an OpenAI/Anthropic key to run extraction. Reuse the BuiltIn agent's own bound credential (admin already configured it once) or require a separate `extractor_credentialId`? Recommended: reuse — fewer moving parts, fewer keys to rotate. |
| 5 | **Storage cost projection** | Pilot inside the team for one month before opening to all users. Watch row count, embedding storage, retrieve latency. Set a soft cap per user (e.g. 1000 memories) for Phase 1. |
| 6 | **Exit / migration plan** | If we tear out mem0 in Phase 4, how do users export or carry over their memories? Build a JSON export endpoint from Phase 1 — cheap insurance against vendor lock-in. |
| 7 | **GDPR DSAR coverage** | When a user files a data subject access request, can we produce all their memories within the legal SLA? Tie this into Phase 2's cascade delete + add an export-all-my-memories endpoint. |

Audit time for these is roughly half a day. Do this **before** any
schema or code change.

---

## 9. When to actually start

I recommend **not starting Phase 1 yet**. Three reasons:

1. **BuiltIn's current product positioning.** The codebase comments and
   prior conversations describe BuiltIn as "configured then executed,
   not for long-horizon tasks". If that positioning holds, mem0 is
   over-engineering — the use cases that justify cross-session memory
   (long-running personal assistant, learning user preferences over
   weeks) are not BuiltIn's job today.
2. **No baseline data.** We just shipped the Langfuse layer. Let it run
   for a few weeks first. If traces show users repeatedly re-providing
   the same context across threads (a signal mem0 would address), the
   need is empirical rather than speculative.
3. **Premature complexity is hard to remove.** Once memories are
   stored, deleting them in production is risky (data loss,
   user-experience regression). Cheaper to defer than to roll back.

**Trigger conditions** — start Phase 1 when **any** of these is true:

- Repeated user complaints: "I have to tell the agent who I am every
  time."
- Product decision to reposition BuiltIn as a long-term assistant.
- Langfuse data shows the same userId pasting near-identical context
  blobs at the start of distinct threads, week after week.

If/when those triggers fire, the plan above is ready to execute. Until
then this document captures the design intent so future contributors do
not have to re-derive it.

---

## 10. Decisions log

> Append entries when scope decisions change.

- **2026-04-27** — Document created. mem0 chosen over Letta / Zep /
  DIY for low integration cost and Postgres reuse; deferred until
  trigger conditions are met (see §9).

---

## 11. Reading list

- [mem0 docs](https://docs.mem0.ai/)
- [mem0 GitHub](https://github.com/mem0ai/mem0)
- [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
  on memory taxonomy.
- [LangChain — Continual learning for AI agents](https://blog.langchain.com/continual-learning-for-ai-agents/)
  framing model weights / harness behavior / contextual memory as three
  separate learning surfaces.
- [GitHub — Building an Agentic Memory System for GitHub Copilot](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)
  on freshness and just-in-time validation — a quality concern that
  surfaces in Phase 3.
- `docs/observability.md` — patterns and infrastructure that mem0
  should reuse rather than re-invent.
