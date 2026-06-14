# Memory Architecture (Proposed)

> Status: **Pre-implementation design / Future Plan**. 

This document describes the proposed architecture for Nango's future agent memory system. It is independent of the KB (Knowledge Base) system.

## 1. Scope & Categories

Memory captures three classes of facts:
1. **User profile** — language, preferences, role. Slow-changing.
2. **User behaviour** — current focus and context.
3. **Agent self-improvement** — execution errors, retried approaches.

(Note: Conversation continuity is handled by a separate Compaction service, not Memory).

## 2. Core Architecture Philosophy

1. **Agent-driven (Tool-based)**: Agents explicitly call a `memory` tool to store durable facts, rather than relying on per-turn LLM auto-extraction.
2. **Built-in always-on**: The system has a built-in memory store. (Optional external plugins like mem0 may be supported in the future).
3. **Frozen snapshot pattern**: At session start, memory is loaded and injected into the system prompt. Mid-session writes are saved to DB immediately but do not mutate the current session's system prompt (preserving LLM prompt cache). The agent uses the `read` action to see live state.
4. **Security-first**: Memory content is attack surface. All writes must be scanned for prompt injections and credentials.

## 3. Session Boundary & Lifecycle

- **Session Start**: Load latest memory from DB → render snapshot → inject into system prompt.
- **Mid-session write**: Write to DB immediately. System prompt UNCHANGED. Agent can read via tool.
- **Next Session**: Snapshot rebuilt from latest DB state.

## 4. Proposed Data Model

### 4.1 `user_memory_entry`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | FK to `user` |
| `agent_id` | uuid | Optional. FK to `builtin_agent` |
| `target` | text | `'memory'` (agent notes) or `'user'` (user profile) |
| `content` | text | |
| `char_count` | int | Denormalized for budget |
| `source` | text | `'agent_tool'`, `'manual_curation'`, `'reflection'` |
| `source_run_id` | uuid | Optional. FK to `entity_run` |
| `version` | bigint | Optimistic lock for concurrent edits |
| `is_deleted` | boolean | Soft delete |

### 4.2 `user_memory_quota`

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | PK part |
| `agent_id` | uuid | PK part |
| `target` | text | PK part |
| `current_chars` | int | |
| `char_limit` | int | Hard cap to force economy |
| `version` | bigint | |

**Proposed Schema Extensions:**
- `builtin_agent.memory_scope`: `'per_agent'` (isolated) or `'shared'`
- `credential.share_user_memory`: boolean (opt-in for external agents)

## 5. Proposed Tool API (the agent-driven path)

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

## 7. Manual Curation UI

Memory must be transparent. A UI panel will allow users to:
- **View**: See all stored memory.
- **Add / Edit / Delete**: Manually curate facts.
- **Clear**: Reset memory (takes effect on next session).

## 8. Security Layer

Every write is scanned before insertion to protect the system prompt.

### 8.1 Threat pattern scanning
| Threat | Examples |
|---|---|
| Prompt injection | ignore previous instructions, you are now... |
| Credential exfiltration | curl ... $API_KEY, cat .env |
| Persistence backdoors | authorized_keys, ~/.ssh |

### 8.2 Secret / PII redaction patterns
Matches against known credential formats (e.g., PEM, Stripe/OpenAI/Anthropic keys, JWTs) and PII (SSN, credit card, phone). Match results in hard reject (or warn for PII).

### 8.3 Single write path
Memory writes are allowed ONLY via the agent tool, manual curation UI, or controlled background reflection. Direct writes from arbitrary skill scripts are forbidden.

## 9. Integration with Other Systems

### 9.1 External Backend Agents
External agents (accessed via credentials) cannot write memory. With user opt-in, user memory (`target='user'`) can be pre-prepended read-only into their system prompt.

### 9.2 Subagents & Delegation
Subagents do not inherit the parent's memory. The parent agent receives the subagent's execution result via an `onDelegation` hook and decides independently whether to record it in its own memory.

### 9.3 Compaction Service
Conversation history compression is handled by a separate background service. It summarizes long threads but does not extract atomic facts into the Memory system.

## 10. Future Rollout Plan

- **Phase 1**: Agent-driven memory tool, frozen-snapshot injection, manual curation UI, threat scanning.
- **Phase 2**: Lifecycle hooks, Provider abstraction for external plugins (like mem0), Compaction service.
- **Phase 3**: Optional reflection pipeline (auto-extraction), vector retrieval for large memory sets.
