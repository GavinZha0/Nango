# Contributing to Nango

Thank you for your interest in contributing to Nango! Contributions of all
kinds are welcome — bug reports, feature ideas, docs, and code.

---

## Before You Start

### Discuss significant changes first

For new features or non-trivial changes, **please open an issue first**
so we can align on direction before you invest time in a PR. This avoids
duplicate work and saves your time.

**Requires discussion:**

- New UI surfaces or major UX changes
- New API endpoints or data-model changes
- New external integrations
- Breaking changes
- Behaviour-changing performance work

**Does NOT require discussion:**

- Bug fixes
- Documentation improvements
- Small UI tweaks
- Pure refactoring (no behaviour change)

---

## Branch Model

Nango uses **GitHub Flow** — a single long-lived trunk plus short-lived
topic branches. There is no `develop` branch.

| Branch | Role | Direct push? |
|---|---|---|
| `main` | Protected trunk. Always green, always releasable. Source of truth for releases and container images. | ❌ |
| `feat/...` `fix/...` `refactor/...` `docs/...` `chore/...` | Short-lived topic branches, branched from `main`, merged back via squash-merge PR. | ✅ |

Workflow:

```
          ┌── feat/foo ──┐
          │              │ squash merge
main ─────┼──────────────┼─────────────────────────────▶ main
          │              │                                │
          └── fix/bar ───┘                                 ▼
                                              release-please PR ─▶ tag
                                                                    │
                                                                    ▼
                                                          container.yml ─▶ GHCR
```

For the full step-by-step contributor workflow (including a worked
bug-fix example and what happens inside GitHub after you push), see
[`docs/dev-workflow.md`](docs/dev-workflow.md).

---

## Getting Started

1. **Fork** this repository on GitHub.

2. **Clone your fork** locally:

   ```bash
   git clone https://github.com/<your-username>/nango.git
   cd nango
   ```

3. **Install dependencies** (this also installs husky hooks):

   ```bash
   corepack enable
   pnpm install
   ```

4. **Create a `.env`** from `.env.example` and fill in the required
   secrets (see the README's *Quick Start* for details).

5. **Create a topic branch** off `main`:

   ```bash
   git checkout main
   git pull --ff-only
   git checkout -b feat/your-feature-name
   ```

6. **Start the dev server** and the bundled Postgres:

   ```bash
   pnpm docker:db
   pnpm db:migrate
   pnpm dev
   ```

---

## Commit Messages

Nango enforces [Conventional Commits](https://www.conventionalcommits.org/)
via a local commit-msg hook (`@commitlint`). Examples:

```
feat: add dashboard refresh button
fix(auth): reject sessions for soft-deleted users
docs: clarify keyring rotation procedure
refactor(runner): extract event coalescer into its own module
chore(deps): bump drizzle-orm to 0.46
```

Allowed types: `feat` `fix` `refactor` `style` `docs` `test` `chore`
`perf` `build` `ci` `revert`.

A `.gitmessage` template is provided. Enable it once with:

```bash
git config commit.template .gitmessage
```

---

## Pull Requests

### PR title rules

**Only the PR title needs to follow Conventional Commits.** Individual
commits inside the branch are free-form because we **squash-merge** every PR.

PR title examples:

- ✅ `feat: add web search tool for built-in agents`
- ✅ `fix(workflow): handle empty DAGs gracefully`
- ✅ `chore: bump dependencies`
- ❌ `Add web search feature` — missing type prefix
- ❌ `feat: Add web search` — subject must be lowercase

The PR title is enforced by the `PR Title Check` workflow.

### Target branch

All PRs — feature, fix, refactor, docs, chore — target **`main`**.
The release PR is created and maintained automatically by
`release-please` and also targets `main`; you only need to review and
merge it when you want to cut a version.

### Before opening a PR

Run locally:

```bash
pnpm lint
pnpm check-types
pnpm test
pnpm test:e2e        # if you touched UI or auth-affected code
```

The same checks run in CI on every PR.

### PR description

Use the template that appears when you open the PR. At minimum, include:

- What changed and why
- How you verified it (commands, manual steps)
- Screenshots / recordings for UI changes (before / after if possible)
- Linked issues (`Closes #123`)

---

## Release Process

Releases are fully automated by
[Release Please](https://github.com/googleapis/release-please):

1. Topic-branch PRs are squash-merged into `main` over time.
2. After every merge, **release-please** scans the new conventional
   commits on `main` and maintains a long-lived
   `chore(main): release X.Y.Z` PR with the proposed version bump and
   CHANGELOG entries.
3. When you want to cut a version, review and merge that release PR. It
   triggers:
   - A git tag + GitHub Release with the changelog.
   - The `Publish Container` workflow building multi-arch images
     (`linux/amd64` + `linux/arm64`) and pushing to
     `ghcr.io/GavinZha0/nango` with `latest`, `vX.Y.Z`, `vX.Y`, `vX` tags.

Version bump rules:

- `feat:` → minor bump (0.1.0 → 0.2.0)
- `fix:` `perf:` `refactor:` → patch bump (0.1.0 → 0.1.1)
- `feat!:` or `BREAKING CHANGE:` footer → major bump (0.1.0 → 1.0.0)

---

## Security

If you find a security vulnerability, **do not open a public issue**.
Email the maintainer or use GitHub's private vulnerability reporting.

---

## Thank You

Every contribution — from a typo fix to a major feature — makes Nango
better. We appreciate your time.
