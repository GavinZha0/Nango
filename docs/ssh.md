# SSH integration

> **Status:** shipped. This document describes the as-built system.
> Plan history (V1 single-blob credential, V2 split, verify-connection
> rework, runtime policy enforcement) is captured in git; do not treat
> any "future work" entry below as imminent.

## 1. Position in the architecture

SSH is one of four agent-bound external resource types — peer with
**MCP servers**, **Skills**, and **Data sources**. All four:

- live in the `builtin_agent_tool` junction table with a `tool_type`
  discriminator,
- contribute a system-prompt block when bound to an agent,
- auto-mount their consuming tool(s) so the binding alone is the
  signal that "the agent can use this resource",
- use the unified `credential` table for AES-256-GCM encrypted
  authentication material — credentials never reach the LLM.

The closest analogue is the data source. Both expose external
infrastructure to the agent through a `name`-keyed slug, and both
split connection metadata (on the resource row) from authentication
(on a linked `credential`). Where they differ:

| Concern | Data source | SSH |
|---|---|---|
| Adapter strategy | One adapter per DB engine (`adapters/postgres.ts`, `adapters/mysql.ts`, `adapters/mariadb.ts`, `adapters/vertica.ts`) | A single library (`node-ssh`) handles every host |
| Tool surface | One tool: `extract_dataset_by_sql` | Two tools: `run_ssh_command`, `list_ssh_hosts` |
| Output shape | Materialised dataset (Parquet sidecar in cache) | Captured stdout / stderr / exit code |
| Policy gate | `data-sources/policy.ts` parses SQL, rejects writes / disallowed tables | `lib/ssh/policy.ts` regex-matches the command before opening the channel |

Not an MCP sidecar. Surveyed SSH MCP servers either hard-code one
host per process, expose secrets via env vars, or duplicate the
credential layer. Built-in tooling beats sidecar on every axis here:
credential plumbing, audit (`entity_run_event` is free), no extra
process to manage, multi-host through a single slug.

## 2. Data model

The credential **reuses existing types** — Nango deliberately does
not mint an SSH-specific shape. The OS username travels with the
credential alongside the secret, so a single credential identifies
one OS user across many hosts.

```
credential
├─ id, name, enabled
├─ type ∈ {'basic_auth', 'private_key'}
├─ service_type='integration', provider='ssh'   (canonical SSH)
└─ encrypted_payload  (AES-256-GCM, shape per `type`):

   type = 'basic_auth':
   { username: string, password: string }

   type = 'private_key':
   { username: string, privateKey: string, passphrase?: string }

ssh_server
├─ id, name (LLM-facing slug, globally unique, regex
│           [a-z][a-z0-9_-]{0,62})
├─ description (free-text; injected into the agent prompt)
├─ credential_id (FK, RESTRICT on delete)
├─ host, port (default 22)
├─ known_host_fingerprint  (pinned, format SHA256:<base64>)
├─ command_allow jsonb<string[] | null>
├─ command_deny  jsonb<string[]>     (default [])
├─ enabled, visibility ('private' | 'public')
└─ created_by, updated_by, created_at, updated_at

builtin_agent_tool
├─ tool_type = 'ssh_server'
└─ ssh_server_id  (FK, SET NULL on delete)
```

Notes:

- **No `username` column on `ssh_server`** — sourced at runtime from
  the credential payload (`auth-loader.ts` normalises both shapes
  into `NormalisedSshAuth = {kind, username, ...secret}`).
- **Strict pinning at runtime.** `known_host_fingerprint` is
  `NOT NULL`. `client.ts` always strict-compares the offered key
  against the pin and rejects on mismatch. The only relaxation is
  capture mode used by `verifyConnection` — see §4.
- **RBAC.** Editors+ create / manage `ssh_server` rows. Admins
  manage `credential` rows. The split lets editors do ssh-server
  work without ever seeing the secret.

### 2.1 Credential payload schemas

```ts
// lib/ssh/credential-schema.ts
export const SshBasicAuthPayload = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const SshPrivateKeyPayload = z.object({
  username: z.string().min(1),
  privateKey: z.string().min(1),    // OpenSSH PEM body
  passphrase: z.string().optional(),
});

export type NormalisedSshAuth =
  | { kind: "password";   username: string; password: string }
  | { kind: "privateKey"; username: string; privateKey: string;
      passphrase?: string };
```

`auth-loader.ts` reads `credential.type`, picks the matching schema,
returns the normalised `kind`-discriminated record that `client.ts`
consumes. Decrypt or schema-parse failures log a warning and return
`null` — the tool wrapper surfaces `CREDENTIAL_DECRYPT_FAILED`
without crashing the run.

### 2.2 ssh_server validation

API-layer (`lib/ssh/validation.ts`):

| Field | Rule |
|---|---|
| `name` | regex `^[a-z][a-z0-9_-]{0,62}$`, immutable post-create |
| `host` | non-empty string (no DNS / IP parsing — fail loudly at connect) |
| `port` | int `[1, 65535]`, default 22 |
| `knownHostFingerprint` | regex `^SHA256:[A-Za-z0-9+/=]+$`. **Optional on create** — server runs auto-verify and pins when missing (§4) |
| `credentialId` | must reference a row whose `type ∈ {'basic_auth', 'private_key'}` (cross-checked at POST/PATCH) |
| `commandAllow` | `string[] | null`, regex patterns; null = unrestricted |
| `commandDeny`  | `string[]`, regex patterns; takes precedence over allow |

`/api/ssh-credentials` (the editor's credential picker) filters by
`type IN ('basic_auth', 'private_key') AND enabled = true` — any
reusable identity row qualifies, not just rows tagged
`provider='ssh'`. (Rationale: a deploy basic_auth pair could
legitimately back both an SSH login and a non-SSH integration.)

## 3. SSH client (`lib/ssh/client.ts`)

Wraps `node-ssh` (which itself wraps `ssh2`). Exposes three
purpose-built entry points:

| Function | Purpose | Caller |
|---|---|---|
| `execOnServer(server, auth, command, opts)` | Connect, run one command, capture stdout/stderr/exit, dispose | `run_ssh_command` runtime tool |
| `verifyConnection(server, auth)` | One-round-trip handshake-and-auth probe; also captures the host fingerprint when `server.knownHostFingerprint === null` | The "Verify connection" editor button + `POST /api/ssh-servers` auto-verify path when the form omits the fingerprint |
| `SshError` / `SshHostKeyMismatchError` | Error envelopes the runtime tool maps into the LLM-facing result shape | — |

### 3.1 Host-key verification

Strict at runtime, admin-confirmed-TOFU at editor time.

- **Runtime** (`execOnServer`): `hostVerifier` callback computes
  SHA256 of the offered key and strict-compares against
  `server.knownHostFingerprint`. Mismatch throws
  `SshHostKeyMismatchError` BEFORE auth, so a wrong host never sees
  the password / private key. There is no TOFU path, no override
  flag.
- **Editor** (`verifyConnection`): when called with
  `knownHostFingerprint === null`, the verifier records the offered
  key via `onCapture` and allows the connection through to auth.
  Used by the editor's "Verify connection" button — the captured
  fingerprint comes back in the response and auto-fills the input.
  The editor renders an inline red hint ("first connection — please
  verify" or "host key changed: was X, now Y") below the input;
  admin's explicit Save click is the trust anchor.
- **Save without a fingerprint**: the API runs the same
  `verifyConnection` server-side and pins whatever the host sends.
  Auth failure aborts the save (we don't persist a row we can't
  log into).

### 3.2 Output handling

```ts
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
}
```

Caps from env vars (`lib/ssh/limits.ts`, parallel to
`data-sources/limits.ts`):

| Env var | Default | Purpose |
|---|---|---|
| `SSH_CONNECT_TIMEOUT_MS`     | 10 000     | TCP + handshake budget |
| `SSH_EXEC_TIMEOUT_MS`        | 30 000     | Per-call wall-clock cap |
| `SSH_EXEC_MAX_OUTPUT_BYTES`  | 1 048 576  | Per-stream byte cap |

Output exceeding the byte cap sets `truncated: true` and the rest is
dropped. `AbortSignal` triggers `ssh.dispose()`; the remote process
keeps running (SSH cannot pre-empt server-side execution after
channel close), but the tool returns immediately with
`signal: "ABORTED"` and `exitCode: null` so the agent unblocks.

### 3.3 Login-shell wrapping

`ssh2`'s exec channel runs the command in a **non-login, non-interactive**
bash, which does NOT source `/etc/profile`, `~/.bash_profile`, or
`/etc/profile.d/*.sh`. So product-specific `PATH` exports
(e.g. `/opt/appd/bin` injected by `/etc/profile.d/appd.sh`) are
invisible — `appd version` fails with "command not found" even though
it works fine when an admin SSHes in interactively.

Each `ssh_server` row has a boolean `login_shell` (default `true`)
controlling this. When `true`, `execOnServer` rewrites the command:

```
<user command>           →     bash -lc '<user command>'
```

via `buildLoginShellCommand()` + `shellSingleQuote()` in
`lib/ssh/client.ts`. Single quotes are escaped with the classic
`'\''` close/escape/reopen pattern; everything else (`$`, backticks,
backslashes) stays literal because POSIX single quotes are
literal-by-design.

**Turn off** (`login_shell = false`) for:
- Hosts without `/bin/bash` — Alpine / busybox / network devices / scratch containers.
- Hosts whose profile scripts echo banners that would pollute stdout.
- Hosts whose profile sets `set -e` / `set -u` / heavy startup (conda init etc.).

**Where the toggle lives**: `ssh_server.login_shell` column;
surfaced in the SSH server editor as a Switch labeled "Login shell".
The command policy (allow/deny in §5) is evaluated against the
**original** unwrapped command, not the `bash -lc '…'` form.

## 4. Runtime tools (`lib/ssh/runtime-tools.ts`)

```ts
defineTool({
  name: "run_ssh_command",
  description: "Execute a single shell command on a remote SSH host. " +
    "Pass `serverName` (the ssh_server's slug — see list_ssh_hosts) " +
    "and the shell command. Returns { stdout, stderr, exitCode, " +
    "signal, durationMs, truncated }. The command runs as the " +
    "server's configured user — full shell access on a host can be " +
    "wide-blast, and per-server command allow / deny patterns may " +
    "reject the call before it reaches the host (`error: " +
    "'POLICY_DENIED'`). Output is capped at " +
    "SSH_EXEC_MAX_OUTPUT_BYTES (default 1 MiB per stream); exceeding " +
    "sets `truncated: true`.",
  parameters: z.object({
    serverName: z.string(),
    command: z.string().min(1).max(8000),
    // SECONDS — field name disambiguates from the LLM's setTimeout /
    // OpenSSH ms intuition. Boundary converts to ms before calling
    // execOnServer.
    timeoutSeconds: z.number().int().min(1).max(300).optional(),
  }),
  ...
});

defineTool({
  name: "list_ssh_hosts",
  description: "List the SSH hosts bound to this agent. Returns " +
    "[{ name, host, port, description }]. Pass `name` as the " +
    "`serverName` argument to run_ssh_command.",
  parameters: z.object({}),
  ...
});
```

### 4.1 Resolution flow for `run_ssh_command`

```
LLM call
  └─> runtime-tools.execute(args)
       │ args = { serverName, command, timeoutSeconds? }
       │
       ├─ resolveSshServerByName(serverName)         (lib/ssh/lookup.ts)
       │   └─ load ssh_server row
       │       │ enabled? else DISABLED
       │       │ resolved? else NOT_FOUND
       │   └─ loadSshAuth(row.credentialId)          (lib/ssh/auth-loader.ts)
       │       │ credential row + type check + decrypt + zod parse
       │       │ → NormalisedSshAuth { kind, username, ...secret }
       │   └─ ResolvedSshServer { host, port, fingerprint, auth, allow, deny }
       │
       ├─ allowedIds.has(server.id)?                 (binding RBAC)
       │   else { ok:false, error:'NOT_BOUND' }
       │
       ├─ evaluateCommandPolicy(command, allow, deny) (lib/ssh/policy.ts)
       │   else { ok:false, error:'POLICY_DENIED', matchedPattern }
       │
       └─ execOnServer({host, port, fp}, auth, command, opts)
           └─ { ok:true, serverName, host, username, ...result }
```

`username` in the response comes from the credential, not from the
LLM call — the LLM never sees it as input. Credentials are resolved,
decrypted, and consumed entirely server-side; nothing in the
`ToolResult` envelope or the persisted `entity_run_event` row carries
the secret.

### 4.2 Auto-mount and prompt block

`lib/runner/dispatch/builtin.ts` walks the agent's bound tools and
collects `sshServerIds`. When that list is non-empty:

- both `run_ssh_command` and `list_ssh_hosts` are added to the
  per-dispatch `ToolDefinition[]` (regardless of whether the admin
  ticked them in any UI surface — binding is the signal),
- `buildSshHostsPromptBlock(sshServerIds)` produces the system-prompt
  injection:

```
Available SSH hosts (pass the slug as `serverName` to run_ssh_command).
Each host has a configured OS user — the command runs as that user
with FULL shell access on the host (there is no remote sandbox).
Hosts marked `[restricted]` additionally enforce a per-server
command allow / deny policy; rejected calls come back with
`error: 'POLICY_DENIED'` (unrestricted hosts skip that gate). Treat
this like an authenticated terminal session: use it for diagnostics,
log inspection, controlled deploys; do NOT use it to mutate data you
cannot easily roll back. Output is captured (stdout, stderr,
exitCode) and may be truncated if very large.
  - prod-web-1 (10.0.1.5:22) [restricted] — production app server, web tier
  - prod-db-1 (10.0.2.5:22) — production primary database
```

Disabled rows are filtered server-side; orphan junction entries
(SET NULL on FK) are silently dropped here.

## 5. Command policy (`lib/ssh/policy.ts`)

`evaluateCommandPolicy(command, allow, deny)` returns
`{allowed, reason?, matchedPattern?}`. Rules:

1. `deny` is checked first; **any** match rejects.
2. `allow === null` → no allowlist constraint (still bound by deny).
3. `allow === []`   → paranoid kill-switch, **nothing** runs.
4. `allow` non-empty → command must match at least one pattern.
5. **Malformed regex on either list fails closed** — admin typos
   never accidentally widen the policy to "anything goes".

Patterns are JS regexes, anchor with `^` for prefix matches. A
denied command short-circuits BEFORE the SSH channel opens; the tool
returns `{ ok: false, error: "POLICY_DENIED", message,
matchedPattern? }` so both the agent and the audit trail can read
the matched rule. Specific patterns are intentionally NOT inlined
into the prompt — restricted hosts get a `[restricted]` tag instead;
the LLM learns specifics from `POLICY_DENIED` responses.

## 6. API surface

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/ssh-servers` | GET | session | Visibility-aware list (own + public for non-admins; everything for admins) |
| `/api/ssh-servers` | POST | editor+ | Create (validates credential type, optional auto-verify when fingerprint omitted) |
| `/api/ssh-servers/[id]` | GET / PATCH / DELETE | editor+ + RBAC | CRUD with `canEditResource` (creator + admin) and `canChangeVisibility` (creator only) |
| `/api/ssh-servers/[id]/verify-connection` | POST | editor+ | Saved-row Verify; returns `{ok, fingerprint, durationMs, pinnedFingerprint, error?}` |
| `/api/ssh-servers/verify-connection` | POST | editor+ | Stateless Verify (used by the New flow); accepts `{host, port?, credentialId}` |
| `/api/ssh-credentials` | GET | session | Picker for the editor: `{id, name, type}` rows where `type ∈ {basic_auth, private_key} ∧ enabled` |

All routes use the standard error envelope from `withSession` /
`withEditor` (`{ ok:false, code, message, requestId, details? }`).

## 7. UI surface

| File | Surface |
|---|---|
| `components/left-panels/SshServerPanel.tsx` | List panel — visibility icons, enable / public toggles, per-row delete. Editor+ visible. |
| `components/middle-panels/SshServerEditor.tsx` | Center editor at `/ssh-server/[id]` (mirrors `/datasource/[id]`). Identity (name + description) / Connection (host / port / credential / fingerprint) / Command policy. "Verify connection" button + Save + Delete in the header. Inline red hint under the fingerprint input when the captured value looks new ("first") or differs from the saved pin ("changed"). |
| `components/middle-panels/BuiltinAgentEditor.tsx` | Adds an "SSH Hosts" Section parallel to "Data Sources" / "Skills" / "MCP Servers" so an agent's bound `ssh_server` ids are managed alongside other tools. |
| `components/admin/CredentialFormDialog.tsx` | When the admin picks `provider='ssh'`, the URL inputs are hidden (host/port/fingerprint live on `ssh_server`), and the Credential Type defaults to `basic_auth` or `private_key` via the standard PAYLOAD_FIELDS path. The dialog has no SSH-specific branch. |

## 8. Hard decisions (locked)

| Question | Decision | Rationale |
|---|---|---|
| Credential carries connection metadata | NO — only auth | One identity, many hosts; RBAC; LLM-facing identifier needs to be on the host row. |
| `ssh_server.name` is the LLM identifier | YES, slug, immutable | Stable across credential rotation; matches `data_source.name`. |
| Auto-mount tools on binding | YES | Same UX trap as data-sources had — binding without the consuming tool produces tool calls that never get a result. |
| Command allow / deny enforced | YES, runtime | Schema + UI + runtime gate landed; fail-closed on malformed regex. |
| Library | `node-ssh` (ssh2 underneath) | Promise API, host-verifier callback, SFTP ready when V2 file-transfer lands. |
| Host-key trust | STRICT at runtime; admin-confirmed TOFU at editor time | Runtime TOFU is silent MITM. Editor TOFU is OpenSSH-style "first connect — accept yes/no" rendered as a red inline hint. |
| `username` column on `ssh_server` | NO — sourced from credential | One credential = one OS identity. Avoids re-pasting username when the same identity authenticates against several hosts. |
| Connection pooling | NONE | Premature; LLM round-trip dominates. |
| MCP sidecar instead | REJECTED | More code, weaker integration. |
| Streaming output | NO | Tool returns final stdout / stderr; consistent with `run_code_in_sandbox`. |
| PTY / interactive shell | OUT | Different protocol shape. |
| SSH agent forwarding | NOT SUPPORTED | Auth from credential payload only. |

## 9. Code map

| Concern | File |
|---|---|
| Credential payload schemas + normalised auth shape | `src/lib/ssh/credential-schema.ts` |
| Decrypt + parse credential row | `src/lib/ssh/auth-loader.ts` |
| `ssh_server` lookup (name → resolved row + auth) | `src/lib/ssh/lookup.ts` |
| `node-ssh` wrapper (`execOnServer`, `verifyConnection`) | `src/lib/ssh/client.ts` |
| Command policy evaluator | `src/lib/ssh/policy.ts` |
| Runtime tool definitions | `src/lib/ssh/runtime-tools.ts` |
| Prompt block | `src/lib/ssh/prompt-block.server.ts` |
| Env-var caps | `src/lib/ssh/limits.ts` |
| Auto-mount + prompt-block injection | `src/lib/runner/dispatch/builtin.ts` (search "ssh_server") |
| API — CRUD + Verify + credential picker | `src/app/api/ssh-servers/`, `src/app/api/ssh-credentials/` |
| Validation schemas (Zod) | `src/lib/ssh/validation.ts` |
| Editor / panel | `src/components/middle-panels/SshServerEditor.tsx`, `src/components/left-panels/SshServerPanel.tsx` |
| Tests | `tests/unit/lib/ssh/{client,credential-schema,limits,lookup,policy}.test.ts` |

## 10. Future work

In rough priority order, when real demand surfaces. None of these are
required for V1 to be useful.

1. **Verify-error-code refinement.** Today `verifyConnection`
   collapses DNS / TCP-refused / handshake-timeout / auth-failed
   into `CONNECT_FAILED` with the underlying message in `error.message`.
   Splitting them into discrete codes (`DNS_FAILED`, `TCP_REFUSED`,
   `HANDSHAKE_TIMEOUT`, `AUTH_FAILED`) plus a lightweight DNS+TCP
   pre-check would make Verify failures self-diagnostic. (~50 LOC.)
2. **Multi-host-key pinning.** Modern SSH servers hold multiple host
   keys (ed25519 / rsa / ecdsa); algorithm preference can drift and
   cause false-positive `HOST_KEY_MISMATCH`. Either store
   `known_host_fingerprints text[]` (any-match), or lock
   `HostKeyAlgorithms` to a single algorithm.
3. **SFTP file transfer tools.** `ssh_put_file` / `ssh_get_file`,
   reusing the same `ssh_server` + credential. node-ssh already
   has the methods.
4. **Connection pool.** Keep one `NodeSSH` per `ssh_server.id`
   alive for ~5 min idle; refcount across in-flight tool calls.
   Same shape as `mcp/provider-pool.ts`.
5. **Interactive PTY tool.** `run_ssh_pty(command)` returning a
   stream the agent / UI can drive interactively. Different
   protocol shape than current one-shot exec.
6. **SSH agent forwarding** (`SSH_AUTH_SOCK`) and **ProxyJump /
   multi-hop**. Both are admin requests we have not heard yet.
7. **Telemetry.** Counter of SSH calls per `ssh_server.id` per day,
   when an aggregator lands.
