# Local command execution — Proposed (NOT yet built)

> **Status: PROPOSED / not implemented.** This document is a design
> record produced from a design discussion, not a description of
> shipped code. Nothing here exists in the codebase yet. Do not cite
> it as "how the system works" — cite it as "how we would build this
> if/when a real need appears."
>
> See §1 for *why* it is deliberately not built yet, and §11 for the
> checklist to run before building it.

A would-be **fifth agent-bound external resource type** — peer with
MCP servers, Skills, Data sources, and SSH — that lets an agent run a
shell command **inside the Nango container** (as opposed to SSH, which
runs on a remote host). The motivating idea: CLIs (`gh`, `kubectl`, …)
are token-efficient compared to raw REST APIs.

---

## 1. Status & decision record — why this is NOT built yet

The feature was fully designed, then **deliberately deferred**. Four
conditions held at design time, and together they say "don't build yet":

1. **No real use case.** It was proposed for completeness, not to serve
   a concrete need.
2. **Medium cost.** ~2000 lines of code + ~500 of docs across ~20-25
   files (estimate in §9), plus permanent carrying cost: test surface,
   security-review surface, cognitive load of two global switches.
3. **Highest security surface in the system.** It hands an LLM a
   credential *and* command execution. Even default-off, its mere
   existence is an attack surface to keep auditing.
4. **MCP and SSH already cover the likely cases.** Every realistic
   target named in discussion (GitHub, GitLab, AWS, Azure, k8s) has a
   mature MCP server; an ops jump-host with the CLI installed is
   reachable via the existing SSH feature. The unique niche for
   local-CLI is narrow (see §10).

**Build trigger.** Revisit when there is a concrete CLI that:
- has **no** usable MCP server, AND
- is **not** reachable on a box you can SSH to, AND
- is used **frequently** enough that the token savings matter, AND
- is **lightweight** (tens of MB, not the 200 MB–1 GB cloud CLIs).

When that appears, §11 is the pre-build checklist.

---

## 2. Position in the architecture

Mirrors the SSH feature almost exactly (`docs/ssh.md`), with "remote
host" replaced by "the local container":

| Concern | SSH (`ssh_server`) | Local command (proposed) |
|---|---|---|
| Where the command runs | Remote host over `node-ssh` | The Nango container itself |
| Connection machinery | host / port / pinned fingerprint + key verification (`client.ts`, ~14 KB) | **none** — just `spawn` |
| Credential | required (username + password/key) | optional (a token, only if the CLI needs one) |
| Tools | `run_ssh_command`, `list_ssh_hosts` | `run_local_command`, `list_local_commands` |
| Execution safety | the remote shell | reuse the **subprocess sandbox adapter** primitives (`src/lib/sandbox/adapters/subprocess/`) |

It is **not** an MCP sidecar and **not** a merge into `ssh_server` —
see §10 for both rejected alternatives.

---

## 3. Data model

```
local_command                               (NEW table)
├─ id              uuid pk
├─ name            text  unique, regex [a-z][a-z0-9_-]{0,62}  (LLM slug)
├─ description     text                       (injected into prompt)
├─ command_allow   jsonb<string[]>  NOT NULL  (regex allowlist; [] = deny all)
├─ command_deny    jsonb<string[]>  default see §5
├─ working_dir     text nullable              (null = per-call tmp dir)
├─ credential_id   uuid nullable FK → credential (RESTRICT on delete)
├─ credential_env_var text nullable           (env name to inject secret as)
├─ enabled         boolean default true
├─ visibility      'private' | 'public'
└─ created_by / updated_by / created_at / updated_at

builtin_agent_tool                          (EXTEND)
├─ tool_type            ← add 'local_command'
└─ local_command_id     uuid nullable FK (SET NULL on delete)

config                                      (TWO new keys — see §5.3)
├─ local_command.enabled   default "false"
└─ ssh.enabled             default "true"
```

Constraint: `credential_id` and `credential_env_var` are set together
or both null (validation layer). A no-credential command is legal.

---

## 4. Credentials — Design A (reuse the credential table)

The decrypted secret is injected into the child process under a
configurable env-var name.

- **Reuse the existing `credential` table** with type `bearer_token`
  (`{ token }`) or `api_key` (`{ apiKey }`). No new credential type —
  exactly how SSH reused `basic_auth` / `private_key`.
- `local_command.credential_env_var` names the target env var
  (`GH_TOKEN`, `AWS_ACCESS_KEY_ID`, …).
- Runtime: decrypt (reusing the `auth-loader.ts` pattern: decrypt →
  zod-parse → on failure return null + `CREDENTIAL_DECRYPT_FAILED`),
  then inject `<credential_env_var>=<secret>` into the child.
- The secret is **never returned to the LLM** (same rule as SSH).

### 4.1 Why A, not "env-passthrough" (Design B — rejected)

Design B would forward a named var from the Node process's own
environment (set in docker-compose) to the child, skipping the
credential table. Rejected because:

- **A keeps the secret encrypted at rest** in the DB and only in
  memory at injection time; B leaves it resident in the Node process's
  ambient env for the whole lifetime.
- **A is house-style** — consistent with SSH / MCP / data-source, all
  of which use the credential table.
- A reuses machinery that already exists (encryption, decryption,
  credential picker UI), so its extra cost is wiring, not new code.

The original appeal of B ("the token is already in my env") rested on
a misconception worth recording: the command runs **in the Nango
container**, a clean image that does **not** carry the developer's
shell env, `~/.ssh`, keychain, or `~/.gitconfig`. So `git`'s usual
auth (keychain / ssh-key / credential-helper) is absent regardless —
only env-reading CLIs (`gh` → `GH_TOKEN`, `aws` → `AWS_*`) fit this
model at all. `git push` would need a token-in-URL workaround, not
"env already has it".

---

## 5. Security model

### 5.1 Five defense layers
```
local_command.enabled  (global kill switch, default OFF)
  ↓ enabled
per-row local_command.enabled  +  agent-binding check (NOT_BOUND)
  ↓
command_allow / command_deny  (regex, evaluated BEFORE spawn)
  ↓
argv-only spawn  (no shell → pipes / substitution / redirection impossible)
  ↓
scrubbed-env allowlist + ONLY the injected credential var + timeout
  + RSS cap + per-call ephemeral cwd  (reused from the subprocess adapter)
```

### 5.2 argv is the hard boundary; regex is advisory
- The tool takes `command: string[]` (e.g. `["gh","issue","list"]`) and
  `spawn`s it directly — **never through a shell**.
- Policy joins argv with spaces and regex-matches (same authoring model
  as SSH's string match).
- Even if the regex is fooled (`["gh","x; rm -rf /"]` → the joined
  string contains `;`), execution is still argv, so `;` is a literal
  argument to `gh`, not a shell separator. **The argv execution is the
  real boundary; the regex is defense-in-depth.**

### 5.2.1 `command_deny` default blocklist (shell-escape prevention)
Even in argv mode, an interpreter as `argv[0]` re-opens arbitrary
execution (`["bash","-c","…"]`). Default-deny these:
```
^(bash|sh|zsh|fish|dash|ksh)$         shell interpreters
^(eval|exec|source|env|xargs)$        indirect execution
-c$  -e$  --eval                       inline-code flags (python -c, node -e, perl -e)
^(ssh|scp|sftp|nc|ncat|socat|telnet)$ pivot / exfiltration
```
- The allowlist must be **non-empty** (empty = deny all; this is the
  existing `policy.ts` semantics).
- Doc guidance: never put an interpreter in the allowlist; use a
  **least-privilege (read-only) credential scope** — that is a more
  reliable boundary than trying to regex out every destructive command.

### 5.3 Container blast radius is NOT "just the container"
Running in the container protects the **host filesystem/process**, but
does **not** contain:
- **the injected credential's reach** — a prompt-injected agent running
  `gh repo delete` damages your GitHub org, not the container;
- **the container's internal network** — it can reach `nango-db` and any
  service on the compose / k8s network.

So "worst case = broken container" is wrong. Worst case = "whatever the
injected credential can do remotely + whatever the container network
can reach."

### 5.4 Two global switches — different defaults, on purpose

| Switch | Default | Why |
|---|---|---|
| `local_command.enabled` | **false** | New, dangerous capability → secure-by-default; off harms no one because it's new. |
| `ssh.enabled` | **true** | SSH is already shipped; defaulting false would break every existing SSH binding on upgrade. |

Same principle as the migration-runner fix (`docs/docker-deployment.md`
§6.6): **secure-by-default for NEW capabilities, preserve-behavior for
EXISTING ones.** Operators can set `ssh.enabled=false` to lock SSH.

**Enforcement = do not mount the tool when off** (not "mount then
refuse"). When `local_command.enabled` is false, `run_local_command`
is never injected into the agent's tool list — agent can't see it,
saves tokens, clear semantics. Same for SSH under `ssh.enabled`. This
also gives an **emergency kill switch**: flip one config to stop all
execution without unbinding agents.

---

## 6. Runtime

```ts
run_local_command(commandName: string, command: string[])
  → resolve by name → global+row enabled? → agent bound? (NOT_BOUND)
  → policy gate (allow/deny regex)
  → decrypt credential (if any) → inject credential_env_var
  → spawn(argv) with scrubbed env + extraEnv + timeout
  → { stdout, stderr, exitCode, durationMs, truncated }

list_local_commands()
  → [{ name, description }] for commands bound to this agent (no secrets)
```

### 6.1 Execution reuses the subprocess adapter
Add an optional `extraEnv?: Record<string,string>` to `SandboxInput`;
the subprocess adapter merges it onto the **already-scrubbed** env
allowlist (the single, controlled hole). `local_command` decrypts its
credential and passes it as `extraEnv`. This reuses all existing
safety machinery — env scrub, timeout, RSS cap, ephemeral cwd, output
processing — adding only one controlled injection point.

Local command uses the **subprocess** path specifically: it needs
network (e.g. `gh` calls GitHub), and the `local-docker` sandbox mode
has no network. A network-enabled, isolated CLI container is the V2
direction (§8), not V1.

---

## 7. UI

```
LeftToolbar: [Command]            (replaces the standalone SSH entry)
     ↓
/command  (list page, two tabs at the LIST level)
  ┌─ Remote SSH ──────────┬─ Local CLI ───────────┐
  │ ssh_server list        │ local_command list      │
  │ [+ New SSH host]       │ [+ New local command]   │
  └────────────────────────┴─────────────────────────┘
       ↓ click row                  ↓ click row
   SSH editor (existing)       Local CLI editor (new):
                               name / description /
                               allow / deny / credential
                               picker / credential_env_var /
                               working_dir / enabled
```
- Two tabs = two lists, each with its own type-specific form. **Not** a
  toggle that morphs one item (that would force the rejected table
  merge — §10).
- Local tab shows a banner when `local_command.enabled` is false:
  "Local command execution is globally disabled. Enable in Admin →
  Config." SSH tab can show the same for `ssh.enabled`.
- **Agent editor**: SSH and Local CLI bindings are grouped together
  under a "Command" group, distinguished by icon (a server/network
  icon for SSH, a terminal icon for local). Underlying bindings are
  still two `builtin_agent_tool` rows; only the UI groups them.
- **No migration / no backward-compat.** `/ssh-server` is simply moved
  to `/command`; old dev data can be dropped. No redirect needed.

---

## 8. Image strategy — the decisive constraint

The hesitation that deferred this feature: each supported CLI must be
installed in the Nango image, which is already 1.32 GB. Approximate
sizes:

| CLI | Approx size | Note |
|---|---|---|
| `gh`, `glab`, `kubectl`, `docker` (client) | ~30-60 MB each | light |
| `aws` CLI v2 | ~150-220 MB | bundles a Python runtime |
| `az` (Azure) | ~500 MB - 1 GB+ | Python + huge dep tree; could double the image |

**Decision: do NOT bundle any CLI in the main image (Option D).**
- The `local_command` mechanism ships lean (≈ zero image delta).
- `run_local_command` returns a clear "binary not found — install it in
  your Nango image" error when `spawn` hits ENOENT.
- Operators add the specific CLIs THEY need via a derived image:
  ```dockerfile
  FROM nango:latest
  RUN apt-get update && apt-get install -y gh kubectl \
      && rm -rf /var/lib/apt/lists/*
  ```
- This decouples CLI choice from Nango releases (adding a CLI is not a
  Nango version bump) and lets each operator own their bloat/benefit
  trade-off. The main image stays 1.32 GB.
- **Heavy cloud CLIs (`aws`, `az`) should prefer MCP servers**, not
  local-CLI — they bloat the most and have the most mature MCP/SDK
  alternatives.

A pre-baked, network-enabled, isolated **CLI sidecar container** (tools
installed, FS/process isolation, credential injected) is the V2
direction if local-CLI ever needs to be both convenient AND properly
contained. Out of scope for V1.

---

## 9. Development plan (phased; each phase one commit, tests stay green)

| Phase | Content | Touches SSH? |
|---|---|---|
| 1. Schema | `local_command` table + `builtin_agent_tool` extension + two config keys; `drizzle-kit generate`; verify `pnpm db:migrate` | no |
| 2. Shared primitives | extract `policy.ts` / `limits.ts` → `lib/command-exec/`, update SSH imports (pure move + re-export) | imports only |
| 3. local-command lib | `lookup` / `validation` / credential injection; add `SandboxInput.extraEnv` + subprocess merge | no |
| 4. Runtime tools + wiring | `run_local_command` / `list_local_commands` (argv) + prompt block; mount gating with **both** global switches | yes (SSH mount gains `ssh.enabled` check) |
| 5. API routes | `/api/local-commands` CRUD (mirror `/api/ssh-servers`) | no |
| 6. UI | `/command` two-tab page + Local editor + global-disabled banner + LeftToolbar + agent-editor grouping | yes (SSH list moves into a tab) |
| 7. Dockerfile + docs | NO bundled CLI (Option D); flip this doc's status to "shipped"; update `docs/ssh.md` (global switch), `CLAUDE.md` / `AGENTS.md` | docs |
| 8. Tests | vitest: policy, credential injection, binding gate, **both** global-switch gates, argv-not-shell | yes (ssh.enabled gate test) |

**Minimal-skeleton option** (if building to learn / prove the concept
rather than to ship full UX): Phase 1 + one tool + global switch +
mount gating + a bare create form, skipping the polished two-tab UI,
agent-editor grouping, and credential picker. ≈ 800-1000 lines.

**Risk points to remember:**
- Phase 4: defaulting `ssh.enabled=true` must not change current SSH
  behavior — test "config unset ⇒ SSH still mounts".
- Phase 6: confirm nothing hardcodes `/ssh-server` links before moving.
- Phase 3: `extraEnv` must only ADD to the scrubbed allowlist — never
  restore `...process.env` (test-cover it).

---

## 10. Rejected alternatives (decision record)

| Alternative | Why rejected |
|---|---|
| **Merge into `ssh_server`** (one table + `kind` toggle) | SSH is shipped & working; merging means migrating the table + rewriting `lib/ssh/*` + API + editor — high risk for a new feature's V1. Required fields also diverge (SSH needs host/port/fingerprint; local doesn't), producing a half-NULL polymorphic table. **Keep two tables, share only the policy/limits primitives + group in UI.** |
| **Design B: env-passthrough** | Leaves the secret resident in the Node process env; diverges from house-style credential table; the "token already in env" premise is a misconception once you realize execution is in a clean container (§4.1). |
| **Bundle CLIs in the main image** | `az` alone could double the 1.32 GB image; couples CLI choice to Nango releases. Replaced by Option D (operator derived image). |
| **MCP sidecar instead of a builtin resource** | Same rationale `docs/ssh.md` §1 gives for SSH: MCP sidecars hard-code one target per process or duplicate the credential layer. But note the inverse is also true — for tools that DO have good MCP servers (GitHub/AWS/k8s), MCP is the *better* choice than local-CLI; that is part of why this feature's niche is narrow. |
| **Build it now** | No use case + ~2000 LOC + highest security surface + "empty shell" until an operator adds CLIs ⇒ defer. The best code is unwritten code. |

---

## 11. Pre-build checklist (run this when a real need appears)

1. **Name the CLI** and confirm it has **no usable MCP server** (if it
   does, prefer MCP — no image bloat, structured output).
2. Confirm it is **not reachable via SSH** on an existing ops host (if
   it is, use the SSH feature).
3. Confirm it is **lightweight** (tens of MB). If it is `aws`/`az`-class,
   strongly prefer MCP.
4. Decide **read-only vs read-write** — scope the credential and the
   `command_allow` default accordingly (read-only narrows the blast
   radius enormously).
5. Then implement per §9, starting from Phase 1, and flip this doc's
   status banner to "shipped — as built" with any deltas from this
   design recorded inline.
