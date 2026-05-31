@AGENTS.md

# Claude-Specific Addendum

`AGENTS.md` (imported above via Claude Code's `@file` syntax) is the
single source of truth for project conventions, architecture rules,
the directory map, and the database schema. Everything below is
**additive** — Claude-specific reminders that go beyond what other
AI tools need.

> **Maintenance rule**: do **not** restate `AGENTS.md` content here.
> If you find yourself copying a rule from `AGENTS.md` into this file,
> the right move is to update `AGENTS.md` instead.

## Why a Claude-Only File Exists

Anthropic models have a knowledge cutoff that lags behind several of
the libraries this repo depends on. The following stacks have shipped
breaking changes that earlier Claude training data does **not**
reflect — always verify against installed versions before generating
code:

- **Next.js 16.2.4** — App Router APIs, conventions, and file
  structure differ from the 13.x / 14.x patterns most commonly
  represented in training data. Read the relevant guide in
  `node_modules/next/dist/docs/` before touching routing, caching,
  or `instrumentation.ts`. Heed deprecation notices.
- **React 19.2.4** — `forwardRef` is no longer needed; `ref` is a
  regular prop. Action / `useActionState` / `useOptimistic` APIs are
  the supported patterns; do not regenerate code that uses the
  legacy `useFormState` shape.
- **Tailwind CSS 4** — use `@import "tailwindcss"` instead of v3's
  `@tailwind base / components / utilities` directives. Utility class
  names are the same.
- **Zod 4** — import via `import { z } from "zod"` (v4 barrel
  export); avoid deprecated v3 method shapes that may surface from
  training data (`z.preprocess` callable form, deprecated
  `z.string().nonempty()`, etc.).

## Working Style Hints for Claude Code

These are workflow conventions specific to running Claude Code in
this repo. Other agents may pick them up too, but they are not part
of the open `AGENTS.md` contract.

- **Read before edit**: this repo's `docs/` directory is the
  authoritative architecture reference. When `AGENTS.md` cites a
  subsystem doc (e.g. `docs/orchestrator.md`, `docs/skills.md`),
  open it before generating non-trivial code in that area.
- **Schema changes**: never hand-write SQL migrations. Always run
  `pnpm db:generate --name=<descriptive>` and commit BOTH the
  `<idx>_<name>.sql` and `meta/<idx>_snapshot.json` files. See
  `AGENTS.md` §7 (Architecture Rule "Schema").
- **Server / client split**: any module that touches secrets, the
  DB, or upstream APIs must start with `import "server-only"`.
  When in doubt, server-only. See `AGENTS.md` §8.
- **Tool failures**: never throw from a tool's `execute` as a
  control-flow mechanism. Return a structured `{ ok: false, error }`
  shape; the `wrapToolExecute` envelope (`AGENTS.md` §19) is only
  there for **unexpected** throws.
- **Comment policy** (`AGENTS.md` "Comment Policy"): only `QUIRK:`,
  `SECURITY:`, and `CONTRACT:` comments are guaranteed to survive a
  refactor. Do not regenerate prose comments that restate the code.
