# E2E Tests

Integration tests for the Nango frontend. These run against a real
PostgreSQL database and a running Next.js server (started automatically by
the Playwright `webServer` config), exercising the UI end-to-end with real
auth sessions — not mocks.

> Dashboard is intentionally out of scope: the feature is not finished yet.

## Directory structure

```
tests/e2e/
├── playwright.config.ts         # at repo root; testDir points here
├── constants/
│   └── test-users.ts            # seeded users (admin / editor / user)
├── helpers/
│   ├── fixtures.ts              # adminTest / editorTest / userTest role factories
│   ├── navigate.ts              # gotoSettled, removeCopilotInspector
│   ├── data.ts                  # uniqueName / uniqueSuffix
│   ├── registry.ts              # test-resource lifecycle (E2E marker + deleteRowByName)
│   └── panels.ts                # left-panel row interactions (panelRow, toggles, openNew)
├── fixtures/
│   └── auth-states.setup.ts     # setup project: signs up users, saves auth state
├── lifecycle/
│   ├── setup.global.ts          # pre-clean marked resources + stale users
│   ├── teardown.global.ts       # post-clean marked resources + test users
│   └── sweep.ts                 # shared resource sweeper with per-table isolation
├── .auth/                       # gitignored storage-state (admin/editor/user)
├── auth/  admin/  editor/  chat/  user/   # specs grouped by role / area
```

## Running

```bash
# Local (needs the DB; dev server is started/reused automatically)
docker compose up -d nango-db
pnpm test:e2e

# One file / one test
pnpm test:e2e tests/e2e/admin/credentials.spec.ts
pnpm test:e2e --grep "credential"
```

CI (`pnpm test:e2e` in `.github/workflows/e2e-tests.yml`) spins up its own
Postgres service on port 5432 and runs the full suite. Locally the DB
defaults to `localhost:5433` (see `getPostgresUrl`).

## Roles & auth state

`fixtures/auth-states.setup.ts` signs up three users and persists their
cookies to `.auth/*.json` (gitignored). Specs then skip sign-in via
`storageState`. The test users live in `constants/test-users.ts` with the
`@test-e2e.local` suffix, which `lifecycle/*` uses to clean up before and
after every run.

| State file | Role | Used by |
|---|---|---|
| `admin.json` | admin | `admin/*`, `chat/*` |
| `editor.json` | editor | `editor/*` |
| `user.json` | user | `user/*` |

## Shared helpers

- `adminTest` / `editorTest` / `userTest` (`helpers/fixtures.ts`) — role-scoped
  test objects with `storageState` pre-set per seeded user, with persistent
  `cpk-web-inspector` CSS shielding via `addInitScript`; prefer these over
  the bare `test` in specs.
- `gotoSettled(page, path, anchor, { accessPath? })` — navigate and wait for a
  visible anchor. Set `accessPath` to self-skip when the session lands elsewhere
  (dirty first-user DB). Replaces `goto` + `waitForTimeout` boilerplate.
- `removeCopilotInspector(page)` — remove the `cpk-web-inspector` overlay
  that otherwise swallows pointer events. Retained for non-fixture contexts.
- `uniqueName(prefix)` / `uniqueSuffix()` — collision-free names for
  test-created resources (embeds the `-e2e-` marker for sweep recovery).
- `deleteRowByName(page, name, dialogTitle?)` (`helpers/registry.ts`) —
  self-cleanup inside specs. Locates the row by name, clicks Delete, confirms
  via the alertdialog, and waits for row detachment.
- `panelRow(page, name)`, `toggleEnabled(row, noun)`,
  `toggleVisibility(row)`, `openNew(page, ariaLabel)`
  (`helpers/panels.ts`) — the left-panel resource rows (agents, MCP
  servers, skills, …) all share the same toggle aria-labels
  ("Enable/Disable <noun>", "Set to public/private", "New <resource>").
  Rows are marked `data-testid="panel-row"` + `data-name` (AgentPanel
  first; other panels adopt the markers as they gain tests).

## Conventions

1. **Locate by role, not text, where possible.** Prefer `getByRole` and
   `aria-label`; the left-panel toggles expose `Enable/Disable <resource>`
   and `Set to public/private`, the "+" buttons expose `New <resource>`.
   Confirm dialogs are `role=alertdialog` (shadcn AlertDialog); form
   dialogs are `role=dialog` — scope the confirm button to the
   alertdialog by name, e.g. `getByRole("alertdialog", { name: "Delete
   credential" })`.
2. **Never depend on test order.** `fullyParallel` is on; each test creates
   its own uniquely-named resources and cleans them up (or relies on the
   global teardown sweep). Do not chain tests via hard-coded names, and do
   not gate assertions on `isVisible().catch(() => false)` — create what
   you need inside the test.
3. **Wait for visible anchors, not time.** CopilotKit's SSE/polling means
   `networkidle` never fires; prefer `expect(locator).toBeVisible()`.
   Base UI select popups animate in — after opening a combobox, wait for
   the option locator before clicking it.
4. **DB access is for data lifecycle only.** Setup/teardown may touch the DB
   to seed/clean users; individual assertions must go through the UI.
   Seeding an admin-managed resource via the API (e.g. an LLM credential
   for the agent editor) is data preparation, not an assertion — see
   `editor/agent.spec.ts` for the pattern.
5. **Viewport.** The default viewport is configured globally to 1600x900 in
   `playwright.config.ts` to reflect real-world editor usage and ensure left/right
   sidebars and headers do not overlap.
6. **Testability & Base resources.**
   - When a UI element can't be located cleanly, add `id` + `htmlFor` label bindings,
     an explicit `aria-label`, or a `data-testid` marker to the page code instead of
     writing fragile structural selectors or relying on index matching (`.first()`).
   - **Base resources contract**: `fixtures/base-seed.ts` seeds shared, read-only
     baseline resources during setup (`Base-LLM-e2e-Credential`, `Base-Datasource-e2e-Credential`,
     `Base-SSH-e2e-Credential`, `Nango` supervisor, `Base-General-e2e-Agent`, `Base-Judge-e2e-Agent`,
     `Base-Mock-e2e-Mcp`, `base-postgres-e2e-ds`, `base-mock-e2e-ssh`) with `visibility: "public"`.
     Tests may view, select, and assert against them, but must **never** edit, toggle,
     or delete them. Destructive/CRUD tests must create their own isolated resources
     using `uniqueName()`.
   - **Notice on DB direct seeding**: Notification base resources are seeded via direct
     PostgreSQL connection (see `seedBaseNotifications` in `base-seed.ts`) due to the absence
     of an administrative notification management API; column contracts strictly follow `schema.ts`.

## Known constraints

- The CopilotKit dev-inspector overlay (`cpk-web-inspector`) is persistently
  suppressed in role-scoped fixtures via `addInitScript` CSS shielding. For
  non-fixture contexts, `removeCopilotInspector` is available as a manual fallback.
- better-auth rate-limits `/sign-in` + `/sign-up` (3 requests / 10s per IP by
  default) and the E2E suite runs against the production build, where the
  limiter is always enabled. The auth setup project alone exceeds this, so the
  server must run with `E2E_TEST=1` (set automatically by the Playwright
  `webServer` env and by CI), which relaxes the limit to 30/60s. If you run a
  long-lived `pnpm dev` server and reuse it for tests, export `E2E_TEST=1`
  before starting it or the auth specs may fail with "Too many requests".
- `playwright` MCP container (web-auto) is not required for the core specs;
  a subset of web-auto specs will skip or fail until it is healthy.
- Specs that require a specific first-user/admin setup self-skip if the
  authenticated session lacks the expected role (guards against a dirty DB).