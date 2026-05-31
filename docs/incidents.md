# Incidents & Major Changes — Index

A flat, append-only timeline of notable bug fixes, refactor campaigns,
and architecture decisions in this project. Each row is one line;
details live in the linked section of the domain doc — this file is
strictly an **index for discovery**, not a place to write detail.

Why this exists:
- **Debugging path:** an engineer searching by error symptom goes
  straight to the relevant domain doc and finds the failure mode in its
  end-of-doc "Failure modes" / "Case study" section — co-located with
  the architecture. This index is **not** that path.
- **Discovery path:** new contributors, audit reviewers, or anyone
  asking "what went wrong in this project, and what did we learn"
  scans this file, then opens 1-2 detail links. That's what this index
  is for.
- **Pattern recognition:** sorting by Domain or Type makes recurring
  failure shapes visible across topics (e.g. the cluster of pnpm/Next.js
  config migrations all triggered by upstream major bumps).

Maintenance rules — **2 rules, kept deliberately small**:
1. When you add a `Failure modes` entry to a domain doc, add one row
   here pointing to it. **Never copy the detail** — link only.
2. Append-only. Do not edit historical entries; commit history is the
   audit trail. If a fix is later superseded, add a new row that
   supersedes the old one (and update the body of the old domain doc
   to note this, as we already do).

---

## Timeline

| Date | Domain | Type | Headline | Detail |
|---|---|---|---|---|
| 2026-05-30 | Docker | Bug fix | Migration runner drift — host `drizzle-kit` and container `migrate.mjs` tracked applied migrations in two different tables → re-ran baseline → "relation already exists". Unified on one runner/one table (`db:migrate` → `node migrate.mjs`); env via `--env-file-if-exists` (no `dotenv` import, which would crash standalone) | [`docker-deployment.md` §6.6](./docker-deployment.md#66-two-migration-runners-drift--host-drizzle-kit-vs-container-migratemjs) |
| 2026-05-30 | Docker | Bug fix | Image bloat 2.7 GB → 1.32 GB via Next.js standalone `.pnpm` closure repair (fixpoint walk that fills nft-dropped entries + dlopen sidecars) | [`docker-deployment.md` §6.5](./docker-deployment.md#65-pnpm-symlink-layout-vs-nextjs-standalone-nft), [§7 case study](./docker-deployment.md#7-case-study-shrinking-the-27-gb-image-and-the-traps-on-the-way) |
| 2026-05-29 | Docker | Interim fix | `prod-deps` stage split — modest size reduction (≤40 MB); **superseded** by 2026-05-30 closure repair | [`docker-deployment.md` §6.5 "Superseded interim fix"](./docker-deployment.md#65-pnpm-symlink-layout-vs-nextjs-standalone-nft) |
| 2026-05-29 | Docker | Bug fix | `docker compose up` end-to-end fix on a clean host — chain of 6 unrelated upstream bumps (pnpm 10→11 workspace.yaml move, Next.js 15→16 config schema, PG 17→18 volume layout, pino-pretty nft gap, pnpm symlink + nft incompatibility, BuildKit dir-vs-file conflict) | [`docker-deployment.md` §6.1–§6.5](./docker-deployment.md#6-failure-modes-we-have-hit) |
| 2026-05-29 | Codebase | Refactor | Comment-cleanup campaign — A-F triage rules, D-rule pre-commit guard, ~-3400 lines across ~35 commits; codified principles for "UI is self-describing", trim+verify combined, file-picking by absolute count not density alone | [`code-comments.md`](./code-comments.md) |

---

## Notes on coverage

- **Domain docs without an entry here** simply have not had a major
  incident yet. The absence of an entry is meaningful — it's not an
  oversight, it's a signal the area has been quiet.
- **Refactor campaigns** are listed when they cross multiple commits
  AND establish a durable rule / pattern (e.g. the comment-cleanup
  campaign created `docs/code-comments.md` + a pre-commit guard).
  One-off refactors live in commit history only.
- **Migration / config-bump incidents** (the pnpm 10→11, Next 15→16,
  PG 17→18 cluster on 2026-05-29) are intentionally grouped under
  the single `docker compose up` headline. The cluster IS the lesson:
  upstream major bumps tend to break Docker assembly in correlated
  ways, and the `docs/docker-deployment.md` upgrade checklist (§3)
  exists specifically to pre-empt them.
