# Code Comments Guide

> One page. Read it once, apply forever.
>

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

Do not write comments that merely repeat what the code does (e.g., adding `// Loop through users` before a `for` loop).
**Frontend special case**: Visual layout is self-describing. Do not comment on proportions or colours that are already defined in class names and visible on screen. Only keep comments for non-visual gotchas, accessibility intent, or section markers.

### B — Status / migration narrative → DELETE

Anything that talks about the *journey* of the code (e.g., "Plan to switch to B in V2", "Migrated from X to Y") is dead weight. Use `git log` for historical context.

### C — WHY / design rationale → COMPRESS HARD

A short *why* line is fine when the *what* is non-obvious. Multi-paragraph discussions of alternatives or design debates belong in `docs/<subsystem>.md`, not in source files.

### D — Anchors and cross-references → POINT TO THE DOC ONLY

Do not embed design-decision IDs, phase markers, version markers, or section numbers in source comments. Point at the document file name instead (e.g., `See docs/orchestrator.md`), as documents are frequently reorganized.
Exception: External standards references (e.g., `RFC 6749 §4.4.3`) are allowed.

### E — Gotchas, warnings, footguns → KEEP

Anything a future contributor *must* see to avoid breaking something. Keep it short and imperative.

### F — File-header architecture essays → MOVE TO `docs/`

A 30-line file header explaining the whole subsystem is documentation hiding in a code file. Move it to the appropriate `docs/` file and replace the header with a single pointer line.

---

## Before You Commit a Comment

Three questions:

1. **Does the code already say this?** → delete.
2. **Will this still be true in six months without anyone updating it?**
   → if no, delete; if yes, keep.
3. **Could this live in `docs/<subsystem>.md` instead?** → move it.

A comment that survives all three is worth keeping. Most don't.

---

---

## What This Guide Does Not Cover

- API contract docs (zod schemas, exported function signatures) — those
  belong on the type definitions, not inline.
- Test descriptions (`it("...")` strings) — write them like sentences;
  they ARE the spec for that case.
- Generated files (`migrations/`, `*.snapshot.json`, etc.) — leave
  alone; tool-managed.
