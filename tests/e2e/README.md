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
│   ├── registry.ts              # test-resource lifecycle (marker + trackResource + deleteRowByName)
│   ├── panels.ts                # left-panel row interactions (panelRow, toggles, openNew)
│   └── dialog.ts                # fillAndSubmit for form dialogs
├── fixtures/
│   └── auth-states.setup.ts     # setup project: signs up users, saves auth state
├── lifecycle/
│   ├── setup.global.ts          # pre-clean stale @test-e2e.local users
│   └── teardown.global.ts       # post-clean test users
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
  test objects with `storageState` pre-set per seeded user; prefer these over
  the bare `test` in specs.
- `gotoSettled(page, path, anchor, { accessPath? })` — navigate, strip the
  CopilotKit inspector overlay, wait for a visible anchor. Set `accessPath` to
  self-skip when the session lands elsewhere (dirty first-user DB). Replaces
  `goto` + `waitForTimeout` + overlay-removal boilerplate.
- `removeCopilotInspector(page)` — remove the `cpk-web-inspector` overlay
  that otherwise swallows pointer events.
- `uniqueName(prefix)` / `uniqueSuffix()` — collision-free names for
  test-created resources.

- `uniqueName(prefix)` / `uniqueSuffix()` — collision-free names for
  test-created resources.
- `trackResource(kind, name)` + `deleteRowByName(page, name)`
  (`helpers/registry.ts`) — lifecycle bookkeeping. Every test-created
  resource MUST be named via `uniqueName()` (it embeds the `-e2e-`
  marker); the global teardown sweeps all domain tables for rows whose
  name carries the marker, so even a crashed run leaves nothing behind.
  Inside a spec, call `deleteRowByName` after the assertions to clean up
  eagerly; the sweep is the backstop, not the primary mechanism.
- `panelRow(page, name)`, `toggleEnabled(row, noun)`,
  `toggleVisibility(row)`, `openNew(page, ariaLabel)`
  (`helpers/panels.ts`) — the left-panel resource rows (agents, MCP
  servers, skills, …) all share the same toggle aria-labels
  ("Enable/Disable <noun>", "Set to public/private", "New <resource>").
  Rows are marked `data-testid="panel-row"` + `data-name` (AgentPanel
  first; other panels adopt the markers as they gain tests).
- `fillAndSubmit(dialog, fields, submitLabel)` (`helpers/dialog.ts`) —
  fill a form dialog by visible label text and submit. Submit labels
  match exactly ("Create", not "Creating…").

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
5. **Viewport.** The default 1280x720 viewport squeezes the left panel so
   the resizable separator's hit-area can overlap the panel header's
   action buttons. Specs that interact with left-panel headers or rows
   should widen the viewport (`editorTest.use({ viewport: { width: 1600,
   height: 900 } })` — see agent.spec.ts).
6. **Testability.** When a UI element can't be located cleanly, add
   `id` + `htmlFor` label bindings, an `aria-label`, or a
   `data-testid="panel-row"`-style marker to the page code instead of
   writing fragile structural selectors. Examples:
   `BuiltinAgentEditor` (labelled Name/Model ID inputs, Provider
   combobox), `AgentPanel` (panel-row markers).

## Known constraints

- The CopilotKit dev-inspector overlay (`cpk-web-inspector`) must be removed
  before interacting — see `removeCopilotInspector`.
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