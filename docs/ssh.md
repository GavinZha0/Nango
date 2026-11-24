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
| Tool surface | One tool: `extract_dataset_by_sql` | Three tools: `run_ssh_command`, `list_ssh_hosts`, and `run_skill_script_on_ssh` (mounted when bound skills declare `scripts-on-ssh`) |
| Output shape | Materialised dataset (Parquet sidecar in cache) | Captured stdout / stderr / exit code |
| Policy gate | `data-sources/policy.ts` parses SQL, rejects writes / disallowed tables | `lib/ssh/policy.ts` regex-matches the command before opening the channel |

Not an MCP sidecar. Surveyed SSH MCP servers either hard-code one
host per process, expose secrets via env vars, or duplicate the
credential layer. Built-in tooling beats sidecar on every axis here:
credential plumbing, audit (`entity_run_event` is free), no extra
process to manage, multi-host through a single slug.

## 2. Data model

The credential **reuses existing types** — Nango deliberately does not mint an SSH-specific shape.

**`credential` Table**
| Column | Notes |
|---|---|
| `id`, `name`, `enabled` | Basic fields |
| `type` | `'basic_auth'` \| `'private_key'` |
| `service_type` | `'integration'` |
| `provider` | `'ssh'` |
| `encrypted_payload` | AES-256-GCM. For `basic_auth`: `{username, password}`. For `private_key`: `{username, privateKey, passphrase?}`. |

**`ssh_server` Table**
| Column | Notes |
|---|---|
| `id` | UUID |
| `name` | LLM-facing slug, globally unique. |
| `description` | Injected into the agent prompt. |
| `credential_id` | FK to `credential`. |
| `host`, `port` | Default port 22. |
| `known_host_fingerprint` | Pinned host key. |
| `command_allow`, `command_deny`, `command_approve` | JSON arrays of regex patterns (`allow` / `deny` for execution policy; `approve` for HITL approval triggers). |
| `enabled`, `visibility` | RBAC/UI toggles. |

**`builtin_agent_tool` Table**
| Column | Notes |
|---|---|
| `tool_type` | `'ssh_server'` |
| `ssh_server_id` | FK to `ssh_server` |

### 2.1 Credential payload schemas

Normalised auth shape handled by `auth-loader.ts`:
| Kind | Fields |
|---|---|
| `password` | `username`, `password` |
| `privateKey` | `username`, `privateKey`, optional `passphrase` |

### 2.2 ssh_server validation

API-layer (`lib/ssh/validation.ts`):

| Field | Rule |
|---|---|
| `name` | regex `^[a-z][a-z0-9_-]{0,62}$`, immutable post-create |
| `host` | non-empty string (no DNS / IP parsing — fail loudly at connect) |
| `port` | int `[1, 65535]`, default 22 |
| `knownHostFingerprint` | regex `^SHA256:[A-Za-z0-9+/=]+$` (trailing `=` padding stripped on save). **Optional on create** — server runs auto-verify and pins when missing (§4) |
| `credentialId` | must reference a row whose `type ∈ {'basic_auth', 'private_key'}` (cross-checked at POST/PATCH) |
| `commandAllow` | `string[] | null`, valid JS regex patterns; null = unrestricted |
| `commandApprove` | `string[]`, valid JS regex patterns; commands requiring manual approval in `auto` mode |
| `commandDeny`  | `string[]`, valid JS regex patterns; takes precedence over allow |

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

Caps from config keys (`lib/ssh/limits.ts`, parallel to
`data-sources/limits.ts`):

| Config key | Default | Purpose |
|---|---|---|
| `ssh.connect_timeout`   | 10 s       | TCP + handshake budget |
| `ssh.exec_timeout`      | 60 s       | Per-call wall-clock cap |
| `ssh.max_output_bytes`  | 1 048 576  | Per-stream byte cap (1 MiB) |
| `ssh.max_command_chars` | 20 000     | Max assembled wire command length |
| `ssh.sftp_max_bytes`    | 104 857 600 | Max single-file size for SFTP upload/download (100 MiB) |
| `ssh.pool_idle_timeout` | 180 s      | Idle TTL before a pooled SSH connection is disposed |
| `ssh.max_sessions_per_server` | 10   | Max concurrent exec/SFTP sessions per `ssh_server` (`session-limiter.server.ts`) |

Output exceeding the byte cap sets `truncated: true` and the rest is
dropped. Both `execOnServer` and `runSftpTransfer` share
`runWithSshSession`, which acquires a per-server slot (`acquireSshSessionSlot`)
and starts the wall-clock deadline before slot wait + connect + exec/SFTP.
On timeout or `AbortSignal`, only the call's own channel (`channel.close()`
or `sftp.end()`) is closed — a shared pooled connection is **not**
disposed so sibling concurrent calls keep running (the lease is marked
`destroy: true` on release to evict it for future callers); the remote
process keeps running (SSH cannot pre-empt server-side execution after
channel close), while the tool unblocks immediately (`signal: "ABORTED"`
and `exitCode: null` on abort during exec, or `SshError` on timeout /
pre-exec abort).

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
- Hosts whose profile scripts echo banners that would pollute stdout or read from `stdin` (which would consume streamed skill-script bytes).
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
    command: z.string().min(1).max(16000),
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
    "[{ id, name, description, host, port, commandAllow, commandDeny }]. " +
    "Pass `name` as the `serverName` argument to run_ssh_command.",
  parameters: z.object({}),
  ...
});

defineTool({
  name: "run_skill_script_on_ssh",
  description: "Execute a reviewed skill script on a bound SSH host. " +
    "The script must be declared in the skill's scripts-on-ssh frontmatter. " +
    "Pass `name` (skill name), `filename`, `serverName`, and optional `args` " +
    "and `timeoutSeconds` (1-300, default 60). Returns { ok, serverName, " +
    "host, skill, script, scriptSha256, stdout, stderr, exitCode, signal, " +
    "durationMs, truncated }.",
  parameters: RunSkillScriptOnSshArgs,
  ...
});
```

> **Policy decoupling & stdin delivery for skill scripts on SSH:**
> `run_skill_script_on_ssh` executes reviewed script bytes via `bash -s [-- <args...>]` or `python3 - [<args...>]` with the script source streamed over `stdin` (`execCommand(..., { stdin })`), and passes `skipCommandPolicy: true` to `runOnBoundServer`. For `bash -s`, `wrapBashScriptForStdin` wraps the source in `{\n<script>\n} < /dev/null\n` so inner commands (e.g. `ssh`, `read`) cannot consume the remaining script lines from `stdin`. Streaming via `stdin` avoids `ARG_MAX` / `ssh.max_command_chars` limits and double-quoting on `loginShell` hosts (so long scripts > 15k chars run cleanly, and `ssh.max_command_chars` only bounds the short interpreter + quoted `args` wire command); consequently, scripts must not read raw `stdin` (`read` / `input()` / `sys.stdin`). Because the script source is human-reviewed skill content (not LLM-authored shell input), it bypasses the host's `commandAllow` / `commandDeny` regex policy, while LLM-supplied `args` are still scanned by `evaluateToolRisk` (`DANGEROUS_SSH_PATTERNS`) and trigger human approval when escalated to `critical`.
> Both `run_ssh_command` and `run_skill_script_on_ssh` share the same wire-command length cap (`ssh.max_command_chars`, default 20,000 characters), measured by `runOnBoundServer` via `composeWireCommand(command, server.loginShell)` — the exact string sent to `sshd` (including `loginShell` wrapping and single-quote escaping). `run_ssh_command` additionally keeps a 16,000-character Zod input cap (`RunSshArgs.command`) as an LLM guardrail, leaving room for `loginShell` wrapping.
>
> Script bytes are decoded with a fatal `TextDecoder` before assembly. `Buffer.toString("utf-8")` never throws — it replaces ill-formed sequences with U+FFFD, which would execute as mojibake on the host — so invalid UTF-8 and NUL bytes are refused with `INVALID_SCRIPT_BYTES`, and a leading BOM (which `bash` and `python3 -` both reject) is stripped. Import applies the same check, so dispatch normally never sees the refusal.

> **Mounting rule.** The tool exists only when the agent binds BOTH at least one
> skill declaring `scripts-on-ssh` AND at least one `ssh_server` (see
> `runner/dispatch/builtin.ts`). `buildSkillsRuntime` is handed the same
> `hasSshBindings` flag so its prompt block and the `run_skill_script` refusal
> never advertise a tool that is absent — an unbound agent gets
> `SSH_NOT_AVAILABLE`, not a pointer to a non-existent tool.

### 4.1 Resolution flow for `run_ssh_command`

```
LLM call
  └─> runtime-tools.execute(args)
       │ args = { serverName, command, timeoutSeconds? }
       │
       ├─ resolveSshServerByName(serverName, allowedIds) (lib/ssh/lookup.ts)
       │   └─ filter by agent binding first (NOT_FOUND if unbound)
       │   └─ load ssh_server row
       │       │ enabled? else DISABLED
       │   └─ loadSshAuth(row.credentialId)          (lib/ssh/auth-loader.ts)
       │       │ credential row + type check + decrypt + zod parse
       │       │ → NormalisedSshAuth { kind, username, ...secret }
       │   └─ ResolvedSshServer { host, port, fingerprint, auth, allow, deny }
       │
       ├─ evaluateCommandPolicy(command, allow, deny) (lib/ssh/policy.ts)
       │   else { ok:false, error:'POLICY_DENIED', matchedPattern }
       │
       └─ execOnServer({host, port, fp}, auth, command, opts)
           └─ { ok:true, serverName, host, ...result }
```

`username` is intentionally omitted from the tool result so the credential
identity never enters the LLM context. Credentials are resolved,
decrypted, and consumed entirely server-side; nothing in the
`ToolResult` envelope or the persisted `entity_run_event` row carries
the secret.

### 4.2 Auto-mount and prompt block

`lib/runner/dispatch/builtin.ts` walks the agent's bound tools and
collects `sshServerIds`. When that list is non-empty:

- both `run_ssh_command` and `list_ssh_hosts` are added to the
  per-dispatch `ToolDefinition[]` (regardless of whether the admin
  ticked them in any UI surface — binding is the signal),
- when at least one bound enabled host has `sftp_enabled = true`,
  `ssh_put_file` and `ssh_get_file` are also mounted (local paths are
  jailed to `host.file.root`; calls targeting a host with
  `sftp_enabled = false` return `error: 'SFTP_DISABLED'`). Note that
  `commandAllow` / `commandDeny` do not govern SFTP transfers: `remotePath`
  can target any path writable/readable by the SSH OS user, gated by
  per-host `sftp_enabled`, `ssh_put_file` HITL approval (`riskLevel: 'high'`),
  and `headlessAllowed: false`,
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
into the system prompt block — restricted hosts get a `[restricted]`
tag instead — while `list_ssh_hosts` returns `commandAllow` and
`commandDeny` on each listing so the LLM can inspect constraints
when needed.

**Approval ordering (`commandApprove`)**: in `auto` approval mode,
`toolApprovalMiddleware` (`lib/runner/tool-approval.ts`) evaluates
`commandApprove` regexes *before* `run_ssh_command.execute` runs
`evaluateCommandPolicy`. Consequently, a command matching both
`commandApprove` and `commandDeny` will prompt for human approval
first and then be rejected with `POLICY_DENIED` if approved. Malformed
`commandApprove` regexes fail closed (requiring approval).

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

## 8. Code map

| Concern | File |
|---|---|
| Credential payload schemas + normalised auth shape | `src/lib/ssh/credential-schema.ts` |
| Decrypt + parse credential row | `src/lib/ssh/auth-loader.ts` |
| `ssh_server` lookup (name → resolved row + auth) | `src/lib/ssh/lookup.ts` |
| `node-ssh` wrapper (`execOnServer`, `putFileOnServer`, `getFileFromServer`, `verifyConnection`) | `src/lib/ssh/client.ts` |
| Connection pool (per-`serverId` reuse + idle eviction) | `src/lib/ssh/pool.server.ts` |
| Per-server concurrent session limiter (`MaxSessions`) | `src/lib/ssh/session-limiter.server.ts` |
| Command policy evaluator | `src/lib/ssh/policy.ts` |
| Runtime tool definitions | `src/lib/ssh/runtime-tools.ts` |
| Prompt block | `src/lib/ssh/prompt-block.server.ts` |
| Config-backed limits | `src/lib/ssh/limits.ts` |
| Auto-mount + prompt-block injection | `src/lib/runner/dispatch/builtin.ts` (search "ssh_server") |
| API — CRUD + Verify + credential picker | `src/app/api/ssh-servers/`, `src/app/api/ssh-credentials/` |
| Validation schemas (Zod) | `src/lib/ssh/validation.ts` |
| Editor / panel | `src/components/middle-panels/SshServerEditor.tsx`, `src/components/left-panels/SshServerPanel.tsx` |
| Tests | `tests/unit/lib/ssh/{client,credential-schema,limits,lookup,policy,pool,runtime-tools,security-policy,session-limiter}.test.ts` |

## 9. Future work

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
