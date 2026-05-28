# Memory Architecture — Design Notes

Pre-implementation design for Nango's agent memory system. This is the
synthesis of a multi-round design discussion that studied five reference
projects (deer-flow, Memoh, mem0, hermes-agent, OpenHuman) before
settling on the architecture proposed here.

Status: **all design decisions resolved**. The phased rollout in §13 is
the agreed build order; P1 starts next.

Separate from `docs/kb-architecture.md` (LLM-compiled wiki for external
documents). Memory and KB are independent subsystems — see §11.

---

## 1. Scope & Categories

Memory captures three classes of facts:

1. **User profile** — language, preferences, communication style,
   habits, role. Slow-changing. Reads almost every conversation.
2. **User behaviour** — what the user works on, asks about, focuses on
   currently. Updates more frequently than profile.
3. **Agent self-improvement** — execution errors, retried approaches,
   "next time avoid X". Includes the parent agent's observations of
   what subagents did.

Plus an implicit fourth bucket:

4. **Conversation continuity** — rolling summaries of long threads so
   resumption / new sessions still have context. **This is Compaction,
   not Memory** — separated by design (§10).

KB (`kb-architecture.md`) is a fifth, independent system: external
documents compiled into queryable form. Memory ≠ KB:

| | Memory | KB |
|---|---|---|
| Source | conversations + execution traces | external documents (PDF, MD, web) |
| Subject | the user, the agent, the work | objective knowledge |
| Lifecycle | dynamic, expirable | long-term stable |
| Edit authority | agent + user (curation) | agent (compile) + user (review) |
| Failure mode | wrong fact poisons future turns | retrieval mismatch returns "no answer" |

Both expose tools to the agent. The agent decides which to query.

## 2. Design Philosophy — Four Pivotal Insights

After studying four reference systems we landed on four design choices
that **inverted the obvious defaults**. Each is non-trivial; together
they shape the rest of this doc.

### 2.1 Agent-driven, not LLM-extracted (V1)

Three reference systems (mem0, Memoh, deer-flow) put memory writes
behind a **post-turn LLM extraction skill**. Hermes inverts this: the
agent itself calls a `memory(action=add, ...)` tool during its turn when
it decides something is worth remembering.

For Nango V1 we adopt the Hermes model. Rationale:

- **No per-turn LLM cost** — extraction is a separate LLM call (or two,
  for two-stage Extract→Decide). Multiplied across every turn this is
  real money.
- **Predictable provenance** — every entry traces to a specific
  `entity_run.id`; no random extracted text.
- **Compatible with prompt caching** — the frozen-snapshot pattern
  (§2.3) only works if memory writes are infrequent and bounded.
- **Char budget forces economy** — agent learns to write small, dense
  notes rather than verbose summaries.

The LLM extraction pipeline is preserved as an **optional V2 layer**
(§13) for users who want auto-extraction on top.

### 2.2 Built-in always-on + at most one external provider

Hermes' single-external-provider invariant is a real piece of design:

> Built-in memory always runs (it's the agent's own tool). External
> plugins layer on top — but only one at a time. Two would mean
> conflicting backends, tool schema bloat, and 2× latency.

Nango should adopt this. V1 ships only the built-in. V2 introduces a
`MemoryProvider` interface and database-enforced "at most one
external" rule.

### 2.3 ⭐ Frozen snapshot pattern (prompt cache protection)

This is the most consequential insight, **unique to Hermes**:

```
[Session start = new agent_run]
  load_from_db() → render system_prompt_snapshot
  system prompt = base + snapshot
  First API call establishes prefix cache
[Mid-session]
  agent calls memory(add="...")
    → DB write committed immediately (durable)
    → tool response shows live state
    → system prompt UNCHANGED (still has snapshot from session start)
  All subsequent API calls in this session hit prefix cache
[Next session = next agent_run]
  load_from_db() refreshes snapshot from latest DB state
  New prefix cache established
```

Anthropic / OpenAI / Bedrock prefix cache hit requires bit-identical
prompt prefix. A memory system that mutates the system prompt mid-
session destroys the cache on every write. For long sessions with
frequent memory writes, this is 10–100× cost amplification.

**Frozen snapshot trades durability vs. immediacy**: writes are
durable (next session sees them) but not instant in the system prompt.
The agent can still see the live state via `memory(action='read')` —
so it doesn't need them in the prompt.

deer-flow, Memoh, mem0 all violate this contract by either re-injecting
on each turn (deer-flow) or putting memory in user messages (Memoh).
Both work for short conversations and cheap models. Neither scales.

### 2.4 Memory is attack surface

Hermes scans every memory entry for:

- **Prompt injection patterns** — `ignore previous instructions`,
  `you are now`, `do not tell the user`, `disregard your rules`
- **Credential exfiltration** — `curl ... $API_KEY`, `cat .env`,
  `cat .netrc`
- **Persistence backdoors** — `authorized_keys`, SSH config paths
- **Invisible Unicode** — zero-width spaces, RTL overrides, bidi
  control chars

Memory enters the system prompt. A malicious string in memory is a
durable jailbreak against every future session. None of the other
three systems do this scanning. **Nango must.**

---

## 3. Session Boundary & Lifecycle

A **session = one `entity_run`** (one chat thread). The frozen snapshot
is bound to this granularity:

| Event | Behaviour |
|---|---|
| New chat / new `entity_run` starts | Load latest memory from DB → render snapshot → inject into system prompt |
| Mid-conversation memory write | Write to DB immediately. System prompt UNCHANGED. Agent can call `memory(action='read')` to see live state. |
| Resume a paused chat (same `entity_run`) | Snapshot remains from initial load (do NOT re-inject on resume; would break prompt cache) |
| Start next chat / fork conversation | New `entity_run` → snapshot rebuilt from latest DB state → cumulative effect |
| User clears memory via UI mid-session | DB cleared. Active sessions still have snapshot in their prompt; UI displays warning *"Effective in new conversations."* |

**Two-tier visibility**:

```
┌───────────────────────────────────────────────────┐
│ System prompt (frozen for this entity_run)        │
│                                                    │
│   <user_memory_state>                              │
│     <entries at session start>                    │
│   </user_memory_state>                             │
│                                                    │
│   <agent_memory_state>                             │
│     <entries at session start>                    │
│   </agent_memory_state>                            │
└───────────────────────────────────────────────────┘
                  │
                  ▼
  Agent can ALSO call: memory(action='read', target='memory')
                       memory(action='read', target='user')
                  → returns fresh DB state (including mid-session writes)
```

This gives **cache stability** (frozen prompt) **with mid-session
continuity** (live tool reads).

## 4. Data Model

Three tables. Postgres-first, consistent with project conventions.

```sql
-- Core: each memory entry as a row
CREATE TABLE user_memory_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  agent_id UUID NULL REFERENCES builtin_agent(id) ON DELETE SET NULL,
  -- For target='user':   agent_id MUST be NULL (user profile is universal)
  -- For target='memory': agent_id depends on the agent's memory_scope:
  --   memory_scope='per_agent' (default) → agent_id = this agent
  --   memory_scope='shared'              → agent_id = NULL (cross-agent pool)

  target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
  -- 'memory': agent's own notes (project conventions, tool quirks, observations)
  -- 'user':   what the agent knows about the user (preferences, role, habits)

  content TEXT NOT NULL,
  char_count INT NOT NULL,         -- denormalised for budget queries

  source TEXT NOT NULL CHECK (source IN (
    'agent_tool',                   -- agent called memory() during a run
    'manual_curation',              -- user edited via Memory panel UI
    'reflection'                    -- V2: LLM extraction skill (optional)
  )),
  source_run_id UUID NULL REFERENCES entity_run(id) ON DELETE SET NULL,

  version BIGINT NOT NULL DEFAULT 1,  -- optimistic lock (drift detection)
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Dedup: (user, agent_or_null, target, content) is unique among non-deleted rows
  -- Implemented via partial unique index (see below) to allow re-adding deleted entries
  CONSTRAINT user_memory_entry_check_target_agent
    CHECK (NOT (target = 'user' AND agent_id IS NOT NULL))
);

-- Live entries lookup
CREATE INDEX user_memory_entry_lookup
  ON user_memory_entry(user_id, agent_id, target)
  WHERE is_deleted = FALSE;

-- Dedup constraint scoped to live entries
CREATE UNIQUE INDEX user_memory_entry_unique_content
  ON user_memory_entry(user_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), target, content)
  WHERE is_deleted = FALSE;

-- Budget tracking (denormalised for fast char-budget checks)
CREATE TABLE user_memory_quota (
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  agent_id UUID NULL REFERENCES builtin_agent(id) ON DELETE SET NULL,
  target TEXT NOT NULL,
  current_chars INT NOT NULL DEFAULT 0,
  char_limit INT NOT NULL DEFAULT 2200,   -- 'memory': 2200, 'user': 1375
  version BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), target)
);
```

**Builtin agent extension** (add column):

```sql
ALTER TABLE builtin_agent
  ADD COLUMN memory_scope TEXT NOT NULL DEFAULT 'per_agent'
    CHECK (memory_scope IN ('per_agent', 'shared'));
-- 'per_agent': agent has its own memory bucket (default; isolated)
-- 'shared':    agent's writes go to the user's cross-agent shared pool
--              (agent_id=NULL for target='memory')
```

**Credential extension** for external agent memory sharing (§9):

```sql
ALTER TABLE credential
  ADD COLUMN share_user_memory BOOLEAN NOT NULL DEFAULT FALSE;
```

Char limits are intentional, borrowed from Hermes:
- `memory`: 2200 chars (agent's notes)
- `user`: 1375 chars (user profile)

Char counts are model-independent. Token counts would require tiktoken
(or equivalent per-model tokenizer), with the additional cost of
recounting whenever the active model changes.

## 5. Tool API (the agent-driven path)

Single tool, multiple actions. Mirrors Hermes' `memory_tool.py`:

```typescript
memory({
  action: 'add' | 'replace' | 'remove' | 'read',
  target: 'memory' | 'user',
  content?: string,    // for add
  old_text?: string,   // for replace / remove (short unique substring)
  new_content?: string // for replace
})
```

### 5.1 Action semantics

| Action | Purpose | Returns |
|---|---|---|
| `add` | Append a new entry (after dedup + budget + scan) | `{success, entry_id, current_chars, budget_limit}` |
| `replace` | Find by substring, replace with new content | `{success, entry_id, current_chars, budget_limit}` |
| `remove` | Find by substring, soft-delete | `{success, current_chars, budget_limit}` |
| `read` | Return current live entries for that target | `{entries: [...], current_chars, budget_limit}` |

Lookup semantics for `replace` / `remove`:
- **Short unique substring** match, not full text and not IDs
- Multiple matches with the same content → operate on first
- Multiple distinct matches → error, ask agent for more specificity

### 5.2 Budget-full behaviour

When `add` (or `replace` with larger content) would exceed the char
limit, **refuse the write**. Return budget state and current entries so
the agent can decide what to evict:

```json
{
  "success": false,
  "error": "memory_budget_exceeded",
  "current_chars": 2150,
  "budget_limit": 2200,
  "attempted_size": 100,
  "current_entries": [
    {"id": "e1", "chars": 80, "content": "...", "updated_at": "..."},
    {"id": "e2", "chars": 120, "content": "...", "updated_at": "..."}
  ],
  "remediation": "Consider removing or compressing existing entries. Use memory(action='remove', old_text='X') or memory(action='replace', old_text='X', new_content='shorter')."
}
```

**No auto-eviction.** Memory is curated — we won't silently drop entries
the agent (or user) may consider critical. Agent must make the
decision (LLM is capable of this) or surface to user via response.

### 5.3 Drift / concurrent-write behaviour

Every entry carries a `version BIGINT`. Writes use optimistic locking:

```sql
UPDATE user_memory_entry
SET content = $1, version = version + 1, updated_at = now()
WHERE id = $2 AND version = $3 AND is_deleted = FALSE;
```

If rowcount = 0 → conflict. Refuse with:

```json
{
  "success": false,
  "error": "memory_entry_modified_concurrently",
  "current_state": { ... fresh entry contents ... },
  "remediation": "Re-read memory and re-issue your change against the current content."
}
```

Same pattern for `user_memory_quota` budget updates.

`Hermes` does this via filesystem round-trip checks; Postgres gives us
the same guarantee more cleanly via optimistic locking.

### 5.4 Tool description (system prompt block)

The tool description in the schema **must** instruct the agent:
- When to use each action
- That entries should be small, dense, factual
- That char budget is enforced and `read` returns fresh state

System prompt explanation:
> "You have a `memory` tool. Use it to record durable observations
> about the user and this work. Entries persist across sessions and
> appear at the top of the next session. Be selective — char budget
> is bounded. Use `action='read'` to see live state including your own
> writes from this session."

## 6. Frozen Snapshot Injection

### 6.1 Session-start path

```typescript
// On EntityRun.start():
const entries = await db.query(
  `SELECT id, target, content
   FROM user_memory_entry
   WHERE user_id = $1
     AND is_deleted = FALSE
     AND (
       (target = 'user' AND agent_id IS NULL)                              -- always per-user
       OR (target = 'memory' AND (
            ($2::uuid IS NOT NULL AND agent_id = $2)                       -- this agent's own bucket
            OR (agent_id IS NULL AND $3::text = 'shared')                  -- shared pool (only for shared-scope agents)
       ))
     )
   ORDER BY target, created_at`,
  [userId, agentId, agentMemoryScope]
);

const userBlock = renderBlock(entries.filter(e => e.target === 'user'));
const memoryBlock = renderBlock(entries.filter(e => e.target === 'memory'));

systemPrompt = base + userBlock + memoryBlock;
```

### 6.2 Render format

```
<user_memory_state>
USER PROFILE (who the user is) [37% — 510/1375 chars]
══════════════════════════════════════════════════════
Prefers concise responses
§
Bilingual EN/ZH, technical communication mostly in English
§
Works on Nango — Next.js + React 19 AI agent workspace
</user_memory_state>

<agent_memory_state>
AGENT MEMORY (this agent's notes) [22% — 484/2200 chars]
══════════════════════════════════════════════════════
User prefers small focused diffs over wholesale rewrites
§
Repo uses Drizzle ORM; never write raw migrations
</agent_memory_state>
```

- Entries delimited by `\n§\n` — multiline-tolerant, rare in actual prose
- Header includes target name + usage percentage (Hermes pattern)
- XML-style wrapping so streaming scrubber (§8.3) can strip if echoed

### 6.3 Mid-session write path

```
1. Agent emits tool_call: memory({action:'add', target:'memory', content:'X'})
2. Handler:
   - scanMemoryContent(X) → reject if pattern matches (§8)
   - SELECT ... FOR UPDATE on user_memory_quota row (budget lock)
   - Check char budget (current_chars + len(X) <= char_limit?)
       → if exceeded: return budget-exceeded error (§5.2)
   - INSERT INTO user_memory_entry ... RETURNING id, version
   - UPDATE user_memory_quota SET current_chars = current_chars + len(X), version = version + 1
   - Commit
3. Tool response includes:
   - {success: true, entry_id, current_chars, budget_limit}
4. System prompt for next API call in this session: UNCHANGED
   (still the snapshot from session start)
5. Agent can call memory(action='read') any time to see this fresh state
```

## 7. Manual Curation UI (V1)

Per resolved decision: manual curation ships **in V1**. Memory is
opaque without inspection; users must be able to see, correct, and
delete what the agent stored about them.

### 7.1 Five actions in V1

| Action | UI control | DB |
|---|---|---|
| **View** | Memory panel, two tabs (`Memory` / `User`), per-entry rows + usage bar | `SELECT WHERE is_deleted=FALSE` |
| **Add** | `+ Add` button → form `{content, target}` | `INSERT WITH source='manual_curation'`, scan first |
| **Edit** | `✎` on row → inline edit (textarea) | `UPDATE WHERE id AND version`, scan first |
| **Delete** | `×` on row → confirm dialog | `UPDATE SET is_deleted=TRUE, deleted_at=now(), version=version+1` |
| **Clear all** | `Reset` button on tab header → strict confirm | Bulk soft-delete |

### 7.2 Mounting

Panel registered in `sidebar-panel-registry` as `LeftPanelId='memory'`.
Toolbar item added to the User group (`LeftToolbar.TOOLBAR_ITEMS`):
visible to all roles (memory is per-user, no role gate beyond auth).

### 7.3 Cleared memory & active sessions

When user clears memory mid-session:
- DB is cleared (soft-delete + reset quota.current_chars)
- Active `entity_run` sessions still have the old snapshot in their
  system prompt — agents will continue to behave per the old memory
  until the run ends
- UI shows warning toast: *"Memory cleared. Takes effect in the next conversation."*
- Optional V2: a button "Force refresh now" that ends current run + starts new one

### 7.4 Deferred to V2

- Export / Import JSON
- Source filter (only show `agent_tool` writes, only `manual_curation` writes, ...)
- Search across entries
- Last-used-at column (requires retrieval observability)
- "Show me the conversation that produced this entry" (jumps to `source_run_id`)
- Pin / Star (protect from V2 reflection deletion)

## 8. Security Layer

Every write (from any source: agent tool, manual curation, V2
reflection) passes through `scanMemoryContent()` before INSERT.

### 8.1 Threat pattern scanning (Hermes-derived)

```ts
const MEMORY_THREAT_PATTERNS: Array<[RegExp, string]> = [
  // Prompt injection
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  // Credential exfiltration
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  // Persistence backdoors
  [/authorized_keys/i, "ssh_backdoor"],
  [/\$HOME\/\.ssh|~\/\.ssh/, "ssh_access"],
];

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);
```

Match → reject the write with a clear error. The agent itself sees the
rejection and can retry with sanitised content. Do NOT silently strip —
the agent should know.

### 8.2 Secret / PII redaction patterns (OpenHuman-derived)

Threat-pattern scanning above catches **intent** (prompt injection,
exfil attempts). It does NOT catch the case where the agent accidentally
includes a real credential or PII in a `memory(action='add')` call. A
single leaked API key or live token persisted into memory is a durable
breach — every future session's system prompt would carry it.

OpenHuman's `memory/safety/secrets.rs` + `safety/pii.rs` ship a curated
regex set for this. Adopt the same patterns into Nango's scanner.
Match → reject (same UX as §8.1 threat patterns).

**Secret patterns** (provider-specific, recognise live credentials):

```ts
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // PEM / SSH / PGP private key blocks
  [/-----BEGIN (RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, "private_key_block"],

  // Provider-specific live key prefixes
  [/\bsk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/, "openai_key"],
  [/\bsk-ant-(api03-|sid01-)[A-Za-z0-9_-]{20,}\b/, "anthropic_key"],
  [/\bxai-[A-Za-z0-9]{20,}\b/, "xai_key"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, "github_token"],
  [/\bsk_live_[A-Za-z0-9]{20,}\b/, "stripe_live_key"],
  [/\brk_live_[A-Za-z0-9]{20,}\b/, "stripe_restricted_live_key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "slack_token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "aws_access_key_id"],
  [/\b(?:aws_)?secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i, "aws_secret"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "google_api_key"],
  [/\bya29\.[0-9A-Za-z_-]{50,}\b/, "google_oauth_access"],

  // JWT (three base64 segments)
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, "jwt"],

  // Authorization headers in command/text form
  [/\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{20,}/i, "bearer_token"],

  // Generic high-entropy hex secrets >= 32 chars assigned to *KEY*/*SECRET*/*TOKEN*
  [/\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Fa-f0-9]{32,}['"]?/i, "generic_hex_secret"],
];
```

**PII patterns** (international formats, common identifier classes):

```ts
const PII_PATTERNS: Array<[RegExp, string]> = [
  // National IDs (selected, expand per market need)
  [/\b\d{3}-\d{2}-\d{4}\b/, "us_ssn"],
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/, "br_cpf"],
  [/\b[A-Z]{4}\d{6}[A-Z0-9]{3}\b/, "mx_rfc"],
  [/\b\d{2}-\d{8}-\d{1}\b/, "ar_cuit"],

  // Credit card (Luhn validation recommended in real impl)
  [/\b(?:\d[ -]?){13,19}\b/, "potential_credit_card"],

  // Phone numbers (E.164-ish; tighten in real impl)
  [/\+\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/, "international_phone"],
];
```

**Defensive notes**:

- Patterns above are a starting point; real provider list grows over
  time. Treat the list as living code; review on every dependency add
  that introduces a new credential format.
- **Do not log the matched substring** in audit / telemetry — log only
  the pattern name. Memory rejection telemetry must not become a
  secret-leak channel itself.
- PII regex has false positives (a 13-digit number is not always a
  credit card). For PII we may prefer **warn** semantics (log + still
  write) rather than hard reject, configurable per-deployment. Secrets
  are always hard reject.

OpenHuman's wider safety module also handles JSON-nested secret keys
(`{"api_key": "..."}` inside otherwise-innocent content). For Nango V1
this is over-scope — `memory` content is short text, not nested JSON.
Defer to V2 if we observe agents writing JSON blobs.

### 8.3 Single write path

Memory writes are allowed only via:

| Path | `source` | Authoriser |
|---|---|---|
| Agent calls `memory()` tool during a run | `agent_tool` | Agent decision in tool-call loop |
| User edits via Memory panel UI | `manual_curation` | Active user session |
| V2 Reflection skill (post-run job) | `reflection` | User opted in per-agent |

**No other path is allowed.** In particular:
- **Skill scripts** (`run_skill_script`) **cannot** write memory directly.
  If a skill wants to record something, it must return the info to the
  agent and let the agent call `memory()`.
- **External backend agents** (§9) **cannot** write memory.
- **Direct DB writes** (psql, migration scripts, ...) are operator-
  outside-safety-boundary; they bypass scan / audit / budget.

This single-write-path invariant is what keeps threat scanning,
auditability, and budget consistency reliable.

### 8.4 Streaming context scrubber

When Nango streams agent responses via SSE, agents may echo back
`<user_memory_state>` / `<agent_memory_state>` tags they saw in their
input. Implement a small state machine (port from Hermes'
`StreamingContextScrubber`) that:

- Strips complete `<user_memory_state>...</user_memory_state>` blocks
  (and `<agent_memory_state>`)
- Holds back partial tags at chunk boundaries (could split across
  SSE deltas)
- Truncates the stream if it sees an unterminated open tag at EOS
  (better to lose content than leak memory infrastructure)

## 9. External Backend Agents — Prompt Injection

External agents (A2A / agno / Mastra / Dify / etc. accessed via
`credential` rows of `serviceType='agent'`) are **not under our
control**. We cannot require them to add an MCP server connection or
modify their configuration. Memory must flow via **the only channel we
control**: the message we send them.

### 9.1 Read-only, prompt-injected

```
[User message to external agent]
      │
      ▼
[Nango pre-flight]
      │
      ├─ credential.share_user_memory == TRUE?
      │   ├─ YES: load user memory (target='user'), compile to markdown
      │   │       prepend to messages[0] (system or first message,
      │   │       depending on protocol)
      │   └─ NO:  pass-through unchanged
      │
      ▼
[POST to external agent]
```

Properties:
- **Zero config** on the external side
- External agent sees memory as background context in its prompt
- External agent **cannot** write memory (no tool exposed, no MCP)
- Read-only model is intentional — external agent is outside our trust
  boundary, must not pollute memory

### 9.2 What's injected

| target | Injected to external? | Reason |
|---|---|---|
| `target='user'` | ✅ Injected | User profile is universal context, useful for any agent serving the user |
| `target='memory'` (per builtin agent) | ❌ Never injected | This is the builtin agent's private notes — irrelevant to external agents |
| Per-external-agent memory bucket | ❌ Not supported in V1 | If a user wants persistent context for a specific external agent, they register it as a Nango builtin agent (backend='external') and get a `target='memory'` bucket via that route |

### 9.3 Per-credential opt-in (default OFF)

```sql
credential.share_user_memory BOOLEAN NOT NULL DEFAULT FALSE;
```

UI in credential detail page:

```
┌─ Memory sharing ──────────────────────────────────────┐
│ ☐ Share user memory with this agent                   │
│                                                        │
│ When enabled, your user-level memory will be sent as  │
│ background context with every request to this agent.  │
│                                                        │
│ Includes 5 entries (510 chars).                       │
│ [Preview what would be sent]                          │
└────────────────────────────────────────────────────────┘
```

**Default OFF.** Sending personal data to a third-party agent must be
an explicit user decision. No automatic prompting on credential
creation in V1 (user discovers the setting in credential settings).

### 9.4 V2 enhancements (not in V1)

- Per-entry `shareable` flag (some entries never share, even if
  credential allows)
- Per-credential filter (e.g. share only work-related entries)
- Bidirectional protocol: external agent returns structured "remember
  this" requests, adapter parses + writes (with explicit user consent)
- Protocol adapters for varying system-prompt injection conventions
  (A2A / OpenAI Assistants / Claude Messages / etc.)

## 10. Subagents & Delegation

Resolved: subagents **do not inherit** parent's memory. The parent's
`onDelegation` hook records observations from the child run.

### 10.1 Why no inheritance

- Subagents are short-lived workers spawned by supervisor `delegate_*`
  tools (see `docs/orchestrator.md`)
- They have their own specialised role and shouldn't carry the parent's
  full context
- Injecting parent memory would inflate the subagent's prompt for no
  meaningful gain
- The subagent has its own `target='memory'` bucket (per its own
  `builtin_agent.id`) which it manages independently

### 10.2 onDelegation hook

```ts
async function onDelegationComplete(
  parentRunId: string,
  childRunId: string,
  delegationContext: { task: string; childAgentId: string },
  childResult: { status: 'success' | 'error'; output: string }
) {
  // Parent agent (if it has memory_scope='per_agent') may record observations
  // about this delegation. This runs as part of the parent's turn flow.
  // The parent agent's NEXT tool call could be memory(action='add', ...)
  // to capture the lesson learned.
  //
  // We do NOT auto-write — we surface the delegation result to the parent
  // agent in its tool response and let it decide whether the observation
  // is worth a memory entry.
}
```

The hook **does not write memory directly**. It surfaces the delegation
result back to the parent agent's tool-call loop. The parent agent
decides whether to call `memory(action='add', target='memory',
content='When delegating SQL queries to data-analyst-agent, ...')`.

### 10.3 Compaction implication

When a long-running supervisor session compacts (§10 below), the
compaction summary preserves a list of delegations + outcomes so the
post-compaction parent still has continuity even without memory
inheritance.

## 11. Compaction Service (independent)

Memory is for **distilled long-term facts** (user prefs, agent
observations). Compaction is for **conversation history compression**
when a thread runs long.

These are different concerns and Hermes / Memoh both keep them
separate. Nango follows.

### 11.1 Trigger

Background service watches `entity_run` token usage. When
`input_tokens > threshold` (configurable, default 80% of model
context window), enqueue a compaction job.

### 11.2 What it does

```
1. Read thread's full conversation history
2. LLM-summarise: preserve key facts, decisions, names, dates, results
   (Memoh's compaction prompt is a good starting point — it explicitly
   excludes prior_context to avoid double-recording)
3. Write to thread_compaction_log.summary
4. Update thread metadata to use summary as context for next run
```

### 11.3 Memory provider integration

Before compaction discards old messages, call
`provider.onPreCompress(messages)` on each registered provider.
Providers return text the compaction summary should preserve — letting
them extract long-tail facts that would otherwise be lost.

This is the deer-flow pre-truncation flush idea, generalised.

### 11.4 Why not in Memory

If we did this inside the Memory pipeline, the same LLM call would be
doing two things (extract durable facts AND write narrative summary)
with conflicting goals. Separation gives each subsystem its own prompt
and store, cleaner debugging.

## 12. Provider Abstraction (V2)

V1 ships only the built-in. V2 introduces the abstraction needed for
external providers (mem0 first), inspired by Hermes' lifecycle hooks
and Memoh's provider registry.

### 12.1 Interface

```ts
interface MemoryProvider {
  readonly name: string;            // 'builtin' | 'mem0' | 'honcho' | ...

  // Lifecycle
  isAvailable(): boolean;
  initialize(opts: { userId, agentId, runId, ... }): Promise<void>;
  shutdown(): Promise<void>;

  // Prompt assembly
  systemPromptBlock(): string;
  prefetch(query: string): Promise<string>;
  queuePrefetch(query: string): void;

  // Persistence
  syncTurn(userMsg: string, assistantMsg: string): Promise<void>;

  // Agent-exposed tools (extends MCP)
  getToolSchemas(): ToolSchema[];
  handleToolCall(name: string, args: object): Promise<string>;

  // Lifecycle hooks (override to opt in)
  onTurnStart?(turnNumber, message, ctx): void;
  onSessionEnd?(messages): void;
  onSessionSwitch?(newSessionId, opts): void;
  onPreCompress?(messages): string;          // (§11)
  onDelegation?(task, result, childRunId): void;  // (§10)
  onMemoryWrite?(action, target, content, metadata): void;  // mirror built-in
}
```

### 12.2 Manager

```ts
class MemoryManager {
  private builtin: MemoryProvider;       // always present
  private external: MemoryProvider | null;  // at most one

  addProvider(p: MemoryProvider) {
    if (p.name === 'builtin') {
      this.builtin = p;
      return;
    }
    if (this.external !== null) {
      throw new Error(`Only one external memory provider allowed; ${this.external.name} already registered`);
    }
    this.external = p;
  }
}
```

The "only one external" rule is enforced both at the manager level and
in DB (via a partial unique constraint when the provider table is
introduced in V2).

### 12.3 First adapter target

**mem0** — mature SDK, well-known, easy reference implementation.
Deferred decision on subsequent adapters until V1 + mem0 are in use
long enough to see what's actually missing.

---

## 13. Resolved Decisions

All 12 original open decisions + 3 edge-case decisions, finalised.

| # | Decision | Resolution |
|---|---|---|
| 1 | Embedding for retrieval in V1? | **No** — char budget keeps entries small enough for full injection; agent-driven retrieval works |
| 2 | Char limits: 2200 / 1375? | **Yes, Hermes defaults** — conservative, raise per-user if telemetry warrants |
| 3 | Per-user vs per-(user, agent)? | **Both:** `target='user'` always per-user (`agent_id=NULL`). `target='memory'` per-(user, agent) by default. Agent setting `memory_scope='shared'` opts into a cross-agent pool (`agent_id=NULL`). |
| 4 | Inject to system prompt or user message? | **System prompt** — cache benefit is huge; user-message injection breaks the frozen-snapshot story |
| 5 | Single `memory()` tool or multiple? | **Single with `action` parameter** — Hermes pattern, fewer schema entries |
| 6 | Skills ↔ memory relationship? | **Skill prompts (SKILL.md)** can instruct the agent to use the memory tool — the agent is what calls memory. **Skill scripts** (run_skill_script) **cannot** write memory directly; they must return info to the agent. |
| 7 | Manual curation UI in V1 or V2? | **V1 — 5 actions** (view / add / edit / delete / clear). Trust requires visibility. |
| 8 | V2 reflection opt-in per user or per agent? | **Per agent** — some agents (data-analysis) want reflection, others (lookup) don't. Setting on `builtin_agent`. |
| 9 | mem0 adapter when? | **V2 first external adapter, after V1 ships and runs.** Re-evaluate further adapters after observed need. |
| 10 | Drift detection: refuse or auto-merge? | **Refuse via optimistic lock** — never silently lose a user manual edit; return current state, agent retries |
| 11 | External backend agent memory access? | **Read-only via prompt injection** (not MCP). Default OFF. `credential.share_user_memory` per-credential opt-in with preview UI. Only `target='user'` injected; no per-external-agent bucket in V1. |
| 12 | Subagents inherit parent memory? | **No.** Subagents have their own memory bucket. Parent uses `onDelegation` hook to surface child results; parent agent decides whether to call `memory(add)` itself. |
| A | Session boundary? | **`entity_run` = one session.** One snapshot per run, frozen for the run's lifetime; rebuilt for next run. |
| B | Agent sees its own mid-session writes? | **System prompt stays frozen** (cache stable). **Tool response + `memory(action='read')` returns fresh DB state** including mid-session writes. Two-tier visibility. |
| C | Budget-full behaviour on write? | **Refuse + return budget state + list of current entries.** No auto-eviction (would silently lose curated content). Agent (or user) decides what to evict. |

## 14. Phased Rollout

Manual curation UI promoted from a separate phase into V1, per
resolved decision #7.

| Phase | Work | Outcome |
|---|---|---|
| **P1a: Agent-driven core** (1-2 weeks) | DB tables; `memory_scope` on builtin_agent; `share_user_memory` on credential; `memory` tool with budget refuse + optimistic locking; frozen-snapshot injection; threat-pattern scan (§8.1) + secret/PII regex library (§8.2) | Agents can remember, snapshot preserves cache, security non-negotiable |
| **P1b: Manual curation UI** (3-5 days) | Memory left panel: two tabs (Memory / User), 5 actions (view / add / edit / delete / clear); usage bar; concurrent-edit conflict UX | Users can review + correct; trust foundation |
| **P1c: External agent injection** (2-3 days) | Per-credential `share_user_memory` toggle + preview UI; pre-flight memory injection into external agent requests | External agents get user context with explicit user consent |
| **P1d: Streaming scrubber** (2 days) | State-machine SSE filter for `<*_memory_state>` echo | Memory infrastructure invisible in stream |
| --- | --- | **STOP — re-evaluate after V1 in use** |
| **P2a: Lifecycle hooks** (1 week) | `onSessionEnd`, `onSessionSwitch`, `onDelegation` wired into Nango supervisor flow | Memory survives `/branch`, delegations surface child results to parent's loop |
| **P2b: Provider abstraction + mem0 adapter** (2 weeks) | `MemoryProvider` interface; `MemoryManager` with at-most-one external; mem0 adapter | Optional external backend |
| **P2c: Compaction service** (1 week) | Independent service; `onPreCompress` hook; integrates with Nango runner | Long threads don't lose context |
| **P3a: Reflection pipeline** (V2, opt-in, 2 weeks) | Two-stage Extract→Decide skill (Memoh-style); bilingual correction signal detection (deer-flow); writes with `source='reflection'`; per-agent opt-in via `builtin_agent.reflection_enabled` | Auto-capture for users who want it |
| **P3b: Vector retrieval** (only when budget exceeded in practice) | pgvector + embedding for `memory_search` tool; Context Packer (4 phases + anti-LITM); **hybrid ranking (keyword BM25 + cosine + freshness), NOT naive vector search** (per OpenHuman lesson, §15) | Scales to large memory sets |

The hard line is between **P1 (must ship together)** and **P2+
(conditional)**. P1a → P1b → P1c → P1d is the V1 release.

## 15. Comparison & Attribution

Every non-obvious design choice traces back to one of the five
references. Explicit attribution to make code-reviewer's life easier:

| Design choice | Source | Why |
|---|---|---|
| Agent-driven memory tool (V1) | **Hermes** | Predictable, cheap, debuggable |
| Frozen snapshot pattern | **Hermes** | Prompt-cache preservation |
| Char budget (not token) | **Hermes** | Model-independent |
| Two targets: memory + user | **Hermes** | Forces separation: about-user vs about-work |
| `§` (section sign) entry delimiter | **Hermes** | Multiline OK, rare in actual prose |
| Short-substring replace/remove | **Hermes** | No IDs for the LLM to track |
| Threat pattern scan (prompt injection) | **Hermes** | Memory is attack surface |
| Secret / PII redaction patterns | **OpenHuman** (`memory/safety/`) | Provider-specific regex catches accidental credential leaks; threat scan ≠ secret scan |
| Drift detection | **Hermes** (filesystem) → Nango (DB version) | Concurrent writers |
| Streaming context scrubber | **Hermes** | Agent echo protection |
| Single-write-path invariant | **Hermes** | All writes pass threat scan + audit |
| Provider abstraction interface | **Hermes** + **Memoh** | 8-plugin ecosystem proves the model |
| "Only one external" invariant | **Hermes** | Tool-schema bloat avoidance |
| Lifecycle hooks (12 hooks) | **Hermes** | Each has clear use case (session_switch, delegation, etc.) |
| `onDelegation` hook | **Hermes** | Nango supervisor + workers fit perfectly |
| File-lock concurrency | **Hermes** (fs) → Nango (`SELECT FOR UPDATE`) | Multi-session safety |
| Dedup at insert | **Hermes** + **deer-flow** | Avoid noise |
| Two-stage Extract→Decide (V2 only) | **Memoh** / **mem0** | Cheap+smart split, debuggable |
| Bilingual correction signal regex | **deer-flow** | Cheap pre-filter for high-value updates |
| Pre-compress hook | **deer-flow** + **Hermes** | Don't lose info before truncation |
| Upload-mention scrubbing | **deer-flow** | Defensive against session-only data |
| Context Packer (4 phases) | **Memoh** | V2 retrieval if vector search needed |
| Anti-Lost-In-The-Middle reordering | **Memoh** | V2 retrieval, real research-backed |
| Memory as MCP tool (search) | **Memoh** | Hybrid push/pull |
| Compaction independent of Memory | **Memoh** + **Hermes** | Two concerns, two services |
| Confidence ranking (V2 only) | **deer-flow** + **Memoh** | If extraction is enabled |
| Hybrid ranking (BM25 + cosine + freshness) | **OpenHuman** (`memory/store/unified/query.rs`) | If/when V3 vector retrieval ships, do NOT do naive cosine — combine signals to avoid stale / off-topic hits |

### 15.1 Considered but NOT adopted (different problem space)

OpenHuman is a desktop personal AI (Slack / Gmail / docs ingestion,
local LLM). Its memory architecture solves "how to compress and search
months of passively-ingested data". Nango's memory solves "how to keep
a small set of high-value facts stable in prompt cache". These are
different problems; several OpenHuman patterns are deliberately NOT
adopted:

| Pattern | Why not | Revisit if |
|---|---|---|
| **Bucket-seal summary trees** (`memory_tree/{tree_source,tree_topic,tree_global}/`) | Designed to compress months of passive multi-source ingestion. Nango memory is small + agent-curated; this maps to our KB system instead (`docs/kb-architecture.md`). | Never for memory; KB pipeline may borrow from it. |
| **5-producer learning pipeline + stability scoring with decay** (`learning/{stability_detector,reflection,...}.rs`) | `stability = base × cue × user_state` with per-class half-lives is parameter-tuning intensive. Our V3 single-producer Extract→Decide (mem0 style) is enough. | If V3 reflection turns out to be too coarse and we need multi-signal extraction. |
| **Knowledge graph (subject-predicate-object triples + `memory_graph` table)** | No relationship-query use cases in Nango (no "show me all projects Alice worked on"). | If we add social/relationship reasoning. |
| **Three separate tools (memory_store / memory_recall / memory_forget)** | Decision #5 already settled: single `memory()` + `action` parameter. Hermes pattern, fewer schema entries. | Never. |
| **Per-turn memory re-injection** | OpenHuman pays no token cost (local LLM). We pay per token and depend on prompt cache. Frozen snapshot is the right answer for remote LLM economics. | Never (architectural). |
| **Multi-layer prompt-injection classifier** (3 layers: normalize → rules → classifier) | High false-positive rate ⇒ agent gets memory writes rejected too often, bad UX. Our regex-only scan is sufficient. | If we observe actual injection attacks bypassing the regex scan. |
| **STM/LTM split with 7-day window** | Our memory is all LTM (small curated set, no temporal layering). | If memory grows past budget and recency-based tiering becomes necessary. |

## 16. Reading List

- `docs/copilotkit-provider-lifecycle.md` — why memory must not be
  visible to anything that watches `usePathname()`
- `docs/kb-architecture.md` — sibling subsystem; clear delineation
- hermes-agent: `tools/memory_tool.py`, `agent/memory_provider.py`,
  `agent/memory_manager.py` — the four pivotal insights
- Memoh: `internal/memory/adapters/builtin/formation.go`,
  `context_packer.go` — Extract→Decide + Anti-LITM
- deer-flow: `backend/packages/harness/deerflow/agents/memory/` —
  bilingual signal detection, pre-compress hook
- mem0 documentation — Extract→Decide pattern in its purest form
- OpenHuman: `src/openhuman/memory/safety/{secrets.rs,pii.rs}` —
  secret + PII regex library (V1 adoption); `memory/store/unified/query.rs` —
  hybrid ranking (cited for V3 retrieval). Note: OpenHuman's broader
  bucket-seal tree + learning pipeline solves a different problem
  (long-term multi-source ingestion); see §15.1 for the non-adoption
  rationale.

---

## Decision Summary

- V1 = agent-driven memory tool + frozen snapshot + manual curation UI
  + external-agent prompt injection (opt-in) + streaming scrubber +
  security scan.
- V2 = lifecycle hooks, provider abstraction + mem0 adapter,
  compaction service.
- V3 = reflection pipeline (opt-in), vector retrieval (when needed).
- Char-budget (Hermes pattern) over token-budget for simplicity.
- All filesystem patterns from references map to Postgres rows +
  optimistic locking.
- Single-write-path invariant: agent tool, manual curation, V2
  reflection. Skill scripts and external agents cannot write.

**Ready for P1 implementation.**
