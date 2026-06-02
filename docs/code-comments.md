# Code Comments Guide

> One page. Read it once, apply forever.
>
> Cross-references: see [`docs/incidents.md`](./incidents.md) for the
> project-wide incident timeline including the comment-cleanup campaign
> that produced this document.

Comments rot. Code does not. The longer a comment outlives the code path
it describes, the more likely a new reader is misled by it. This guide
codifies the project's bias: **fewer, sharper comments; defer to docs and
to `git log` for everything else.**

---

## Principles

1. **Code is the source of truth for *what* the system does.** If a
   comment repeats the code, delete the comment.
2. **`docs/` is the source of truth for *how* the system is shaped.**
   Architecture, layered design, module boundaries, key flows — all
   belong in `docs/<subsystem>.md`. Not in source files.
3. **`git log` is the source of truth for *why* something changed.**
   Migration history, prior approaches, decision narrative, "we used to
   do X before Y" — go look at the commits, not the comment.
4. **Comments earn their place by explaining a non-obvious *gotcha*.**
   Everything else is a code smell.

---

## Triage

When you encounter an existing comment (or are about to write one), put
it in one of the buckets below.

### A — Restates the code → DELETE

```ts
// ❌ Adds nothing
// Loop through users and call deactivate
for (const u of users) deactivate(u);

// ❌ Same problem in JSDoc form
/** Returns the user id. */
function getUserId(u: User): string { return u.id; }
```

**Frontend special case — visual layout is self-describing.** UI
code has instant visual feedback: the user opens the page and SEES
the proportions, colours, sizes, alignment. Re-stating them in a
comment is rule-A restatement with extra steps.

```tsx
{/* ❌ Pure restatement — className already says all of this AND
       the browser renders it. */}
{/* Three-column content (tool list + input + result).
    Columns share width at 3:3:4 — tool list and input get equal
    room (~30 % each), result gets the remaining ~40 % since it
    tends to render the longest JSON trees. The tool list moved
    here from the McpPanel sidebar so it can be search-filtered
    and given more room than a nested sidebar list. */}
<div className="flex flex-1">
  <div className="flex-[3] ..." />
  <div className="flex-[3] ..." />
  <div className="flex-[4] ..." />
</div>

{/* ✅ Section marker — enough to find your way in the JSX tree. */}
{/* Three-column content (tool list + input + result). */}
```

What's worth keeping in JSX comments:

- **Non-visual gotchas** — flex `min-w-0` (load-bearing or children
  refuse to truncate), `lg:sticky` (scroll behaviour you can't see
  from a single screenshot), hydration / SSR / `useSyncExternalStore`
  safety notes, layout-shift prevention.
- **A11y intent** — `aria-*` semantics, focus management.
- **Section markers** — `{/* Header */}`, `{/* Footer */}` — one
  line, locates you in the tree.

What's safe to delete:

- "Columns are 3:3:4" / "label is text-sm" — restated from
  className, AND visible in the rendered page.
- "Co-locating Execute with the input column (Fitts' Law)" — UI
  design rationale that gets validated visually.
- "moved here from the McpPanel sidebar" — rule-B journey note.

### B — Status / migration narrative → DELETE

Anything that talks about the *journey* of the code is dead weight the
moment it lands.

```ts
// ❌ The V1.6.2 stub returned null; W1.6.x will wire the real engine.
// ❌ Currently using approach A. Plan to switch to B in V2.
// ❌ Migrated from in-memory cache to DB-backed in PR #123.
```

If the historical context genuinely matters, it lives in `git log`. The
code reflects current reality.

### C — WHY / design rationale → COMPRESS HARD

A short *why* line is fine when the *what* is non-obvious. Multi-
paragraph discussions of alternatives, decision threads, or design
debates are not.

```ts
// ✅ Single line — explains a non-obvious choice tied to current code.
// AbortController, not setTimeout — the timer leaks under vitest workers.
const ctrl = new AbortController();

// ❌ Walks through decision history, names dropped, options enumerated.
// We initially used setTimeout (see PR #88), then briefly evaluated
// p-timeout (#102), but settled on AbortController because the team
// decided (in the 2025-09 review) that ...
const ctrl = new AbortController();
```

Rule of thumb: **if your rationale comment is longer than three lines,
the rationale belongs in `docs/<subsystem>.md`, not in source.**

### D — Anchors and cross-references → POINT TO THE DOC ONLY

Do **not** embed design-decision IDs (`D17`, `W2`, `C1`), phase
markers (`W1.6.2`), version markers (`V1.x`), or section numbers
(`§3.2`, `§7.8`) in source comments. Section numbers shift every
time a document grows; decision IDs only mean something during the
design phase and disappear once a feature ships.

```ts
// ❌ Bound to whatever the doc structure happens to be today.
// D17 — break runner ↔ workflows cycle (see docs/orchestrator.md §3.7.2)

// ❌ Same problem — section numbers move.
// See docs/workflow.md §4.5 for the binding rules.

// ✅ Points at the topic doc and lets the reader navigate.
// See docs/orchestrator.md.

// ✅ Even shorter — and just as useful.
// See docs/workflow.md.
```

Reasoning: docs are reorganised more often than source. Coupling source
comments to specific anchors guarantees drift. Pointing at the document
file name is robust — readers can grep for the topic inside.

**Exception: external standards references.** RFC / IETF / W3C
section numbers are fine because the standards themselves are
stable for decades. `RFC 6749 §4.4.3`, `RFC 7234 §5.2.2`,
`ECMA-262 §22.1.3.30` — all keep.

**Enforced by pre-commit.** `scripts/check-comment-rules.mjs` runs
through `lint-staged` and rejects new violations matching the
patterns above. Run it locally before opening a PR:

```bash
# A specific file or list of files (same interface lint-staged uses).
pnpm comments:check path/to/file.ts ...

# Full repo sweep — walks src/ and scripts/.
pnpm comments:check:all

# Folded into the aggregate check too:
pnpm check  # = lint + check-types + comments:check:all + test
```

### E — Gotchas, warnings, footguns → KEEP

Anything a future contributor *must* see to avoid breaking something.
Keep it short, keep it imperative.

```ts
// ✅ Saves the next person an hour.
// MUST be called before any module reads process.env.

// ✅ The kind of warning that justifies its line.
// Order matters: validate before cache.write — see the data-source policy.

// ✅ Boundary marker, never obvious from the line itself.
import "server-only";
```

### F — File-header architecture essays → MOVE TO `docs/`

A 30-line file header explaining the whole subsystem is documentation
hiding in a code file. The fix is two steps:

1. Make sure `docs/<subsystem>.md` covers what the essay covered. If it
   does not, **update the doc first**.
2. Replace the file header with a single line that points at the doc.

```ts
// ❌ 40 lines of design narrative at the top of agent-pool.ts

// ✅ One line, lets the code start at line 2.
// Built-in agent runtime — see docs/builtin-runtime.md.
```

---

## Before You Commit a Comment

Three questions:

1. **Does the code already say this?** → delete.
2. **Will this still be true in six months without anyone updating it?**
   → if no, delete; if yes, keep.
3. **Could this live in `docs/<subsystem>.md` instead?** → move it.

A comment that survives all three is worth keeping. Most don't.

---

## When Cleaning an Existing Module

Each cleanup pass follows the same loop:

1. Read `docs/<subsystem>.md` first — anchor yourself to what the docs
   currently claim is true.
2. Walk the files in the module. For each comment apply the A–F triage.
3. If a long comment contained rationale or architecture the doc was
   missing, update the doc in the same PR so nothing is lost.
4. Run `pnpm lint && pnpm check-types && pnpm test`.
5. Keep the diff small. One module per PR.

### Trim and verify, in the same pass

Don't split "delete stale comments" and "audit surviving comments"
into two phases. The first 11 modules in the cleanup campaign tried
the split — trim, then audit — and the audit phase missed real
factual errors that only surfaced when the next campaign pass came
back through. Combining them is strictly faster.

For every comment you *keep*, run through:

1. **Parameter / field / function names** the comment cites — grep
   that they still exist with that exact spelling. A long-lived
   JSDoc that mentions `runner.start({kind: "agent"})` when the
   actual field is `entityKind` is no less misleading for being
   well-formatted.
2. **Numeric defaults / status codes / timeouts** — trace each
   number back to the constant or branch it describes. The
   campaign found a "surfaces as a 401-shaped error" claim with
   no corresponding code path; nobody would have caught it just
   skimming.
3. **Cross-module references** — if the comment names a tool, a
   table, an event type, grep the rest of the codebase to
   confirm it exists. We found `ensure_dataset` and
   `modify_workflow` both referenced as if they were
   `defineTool`s, when neither has a definition anywhere.
4. **File headers ending mid-sentence** — a recurring corruption
   pattern. If the first JSDoc trails off ("…for an", "…that
   an", "…the upstream package ships") complete the sentence.

### Same-shape grep

When you find one instance of any rot pattern — a fabricated
identifier, a stale fingerprint claim, a parameter-name drift —
**grep the whole campaign scope for the same pattern before
moving on**. Subagent passes have repeatedly stopped at the first
hit; reviewers have repeatedly caught the second. If a thing
showed up once, it showed up twice.

### Recurring rot patterns to watch for

The campaign turned up five reliable shapes:

1. **Fabricated identifiers** — comment names an API (`ensure_dataset`,
   `modify_workflow`, `runner.start({kind: 'agent'})`) that grep
   can't find in the codebase.
2. **Retired code-path narratives** — paragraph explaining a
   `W1.6.x stub` / `QUERY_HASH_MISMATCH` / `legacy convMap` that
   isn't in the code any more.
3. **Truncated file headers** — JSDoc that trails off mid-clause.
4. **Mischaracterised security posture** — "no TOFU", "strict-only",
   "401-shaped" claims that don't match the implementation.
5. **Parameter-name drift** — JSDoc cites a parameter / field by
   an old name that was renamed in code but not in the comment
   (`kind` -> `entityKind`, `dataSourceId` -> `dataSourceName`).

### Picking files to audit

**Don't filter by density alone.** A 519-line page with 66 comment
lines reads as 12% density and slips through any reasonable density
threshold — but those 66 lines can hide a 10-line `text-sm`/`text-xs`
restatement, a 30-line bridge-architecture essay, and an 18-line
"previously X had bug Y" narrative. Always pair density with an
absolute-count floor:

```bash
# Files worth auditing: heavy in absolute comment count, OR heavy
# in density on a file long enough to plausibly need rule F.
find src -type f \( -name "*.ts" -o -name "*.tsx" \) | while read f; do
  total=$(wc -l < "$f")
  comments=$(grep -cE "^\s*(//|\*|/\*|\{/\*)" "$f")
  if [ "$comments" -gt 25 ]; then
    pct=$(echo "scale=0; $comments * 100 / $total" | bc)
    if [ "$pct" -gt 25 ] || [ "$comments" -gt 50 ]; then
      printf "%4d %4d %3d%% %s\n" "$total" "$comments" "$pct" "$f"
    fi
  fi
done | sort -rn -k2
```

**And audit every tree.** The campaign repeatedly missed entire
subtrees by assuming they were thin: `src/app/` pages got skipped
because the first `page.tsx` happened to be an 8-line shell; the
real offenders were elsewhere in `src/app/` (519-line interactive
pages, 430-line API routes).

---

## What This Guide Does Not Cover

- API contract docs (zod schemas, exported function signatures) — those
  belong on the type definitions, not inline.
- Test descriptions (`it("...")` strings) — write them like sentences;
  they ARE the spec for that case.
- Generated files (`migrations/`, `*.snapshot.json`, etc.) — leave
  alone; tool-managed.
