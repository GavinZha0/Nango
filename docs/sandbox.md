# Sandbox Integration Layer

> Audience: backend engineers building code-execution capabilities, contributors adding new isolation backends
> See also: `docs/architecture.md` §3.3, `docs/data-sources.md`

The sandbox integration layer is one of the three peer integration layers in Nango (`docs/architecture.md` §3.3). It hides OS-level isolation diversity behind a single typed contract and exposes a uniform `run` operation to the agent runtime. Its consumers are agents that need to execute generated Python (and later Node.js / shell) for data analysis. Its inputs are the agent's command + Parquet datasets prepared by the data-source layer.

**Status:** Shipped — code lives under `src/lib/sandbox/` (`types.ts`, `errors.ts`, `path-mapper.ts`, `output.ts`, `registry.server.ts`, `runtime-tools.ts`, `index.ts` plus `adapters/service/`). One backend is available: **ServiceSandboxAdapter** (decoupled external service execution via `dify-sandbox`). This document is the as-built reference.

---

## 1. Goals and non-goals

### Goals

- One uniform interface (`ISandboxAdapter`) so the agent tool surface is identical regardless of the underlying isolation tech.
- Single backend in V1: **Service** (external service-based execution via `dify-sandbox`).
- A **cwd-relative path contract** (`./data/<name>/`) so agent-generated code never sees host filesystem paths. The service adapter surfaces declared datasets under the sandbox's working directory via volume mount (`.cache/datasource/parquet:/opt/python/lib/python3.14/site-packages/data:ro`).
- Hard limits: timeout, memory, CPU. The backend enforces them with the strongest mechanism it has.
- Output truncation + path masking so a noisy or hostile script cannot flood the agent context or leak host paths.
- Configurable service endpoint (`sandbox.service.url`, `sandbox.service.api_key`) and provider selection (`sandbox.service.provider`).

### Non-goals (V1)

- Persistent / session-level sandboxes. Every `run()` is ephemeral: process exits → namespace destroyed → tmp cleared. The shared cache is the only persistence mechanism.
- Inter-sandbox communication. Sandboxes never see each other; if two analyses need to share an intermediate, the orchestration is in the agent's sequence of `run` calls, not inside the sandbox.
- Sandboxed script execution as a user-facing primitive ("upload code and run it"). V1's threat model is *agent-generated code* (LLM-controlled, mostly trusted but might have bugs). User-uploaded untrusted code raises the security bar significantly and would force Nsjail / Docker as the only allowed backends.
- GPU / large-memory workloads. The 256 MB / 0.8-CPU envelope targets data analysis at the scale of `pandas.DataFrame`s up to ~10⁶ rows.

---

## 2. The contract

**`SandboxBackend`**: `"service"`

**`SandboxInput`**
| Field | Type | Description |
|---|---|---|
| `command` | `string[]` | argv array — never a shell string. |
| `stdin` | `string?` | Optional content piped to stdin. |
| `datasets` | `string[]?` | Dataset names to expose read-only at `./data/<name>/` in cwd. |
| `inputFiles` | `Record<string, Buffer>?` | Extra files written to cwd before execution. |
| `timeoutMs` | `number?` | Hard timeout (default: 30000). |
| `maxMemoryMb` | `number?` | Memory cap (default: 256). |
| `maxCpuCores` | `number?` | CPU cap (default: 0.8). |

**`SandboxOutput`**
| Field | Type | Description |
|---|---|---|
| `stdout`, `stderr` | `string` | Truncated, path-masked output. |
| `exit_code` | `number` | Process exit code (124 on timeout). |
| `duration_ms` | `number` | Wall-clock time. |
| `termination` | `enum?` | `"timeout" \| "oom" \| "signal" \| "abort"` |

**`ISandboxAdapter`**
- `backend`: Backend type.
- `displayName`: Human-readable name.
- `isAvailable()`: Returns true if usable in the current environment.
- `run(input: SandboxInput)`: Executes command in a fresh sandbox and returns `SandboxOutput`.

Three things the contract makes explicit:


1. **`command` is `string[]`, never a shell string.** Eliminates an entire class of injection bugs the moment an agent constructs the command from user input.
2. **`datasets` are names, not paths.** The runner resolves them via the data-source layer. The sandbox layer stays in its lane.
3. **No `acquire`/`release`.** Every `run` is a fresh sandbox. Session-level reuse is a deliberate non-goal in V1.

---

## 3. Backends

```
src/lib/sandbox/
  types.ts                          # ISandboxAdapter, SandboxInput, SandboxOutput
  registry.server.ts                # ADAPTERS satisfies Record<SandboxBackend, …>
  path-mapper.ts                    # virtual ↔ host path resolution + output masking
  output.ts                         # truncate, mask, structured error mapping
  errors.ts                         # SandboxError, BackendUnavailableError, ...
  adapters/
    service/
      adapter.server.ts             # REST API bridge to dify-sandbox (/v1/sandbox/run)
docker/dify-sandbox/
  Dockerfile                        # dify-sandbox service Dockerfile
  requirements.txt                  # aggregated skill python dependencies
  config.yaml                       # dify-sandbox configuration
```

### 3.1 ServiceSandboxAdapter (dify-sandbox)

Service mode connects to an external REST-based code execution sandbox (`dify-sandbox`).

- **Endpoint**: `POST /v1/sandbox/run` with `X-Api-Key` authentication header.
- **Credentials**: Automatically looked up from `CredentialTable` (provider: `dify-sandbox`, serviceType: `integration`).
- **Python deps are skill-driven**: `docker/dify-sandbox/requirements.txt` is generated from builtin skills' frontmatter `dependencies-python: [...]` declarations by `pnpm sandbox:build` (which runs `scripts/collect-skill-deps.ts`). Authors who need a new package add it to the relevant `skills/<name>/SKILL.md`, run `pnpm sandbox:build`, and commit the regenerated `requirements.txt` together with the skill change. CI guards against drift via `pnpm sandbox:check`.

### 3.2 Backend selection

The service backend is the only available sandbox backend. The registry resolves it at boot and throws if the service is unreachable.

Boot emits one log line so the status is grep-able:
```
[nango] sandbox active backend: service
```

`isAvailable()` queries the sandbox service health/reachability. The choice is made once at boot (in `instrumentation.ts`); the active adapter is cached for the process lifetime — `_resetActiveAdapterCache()` exists for tests only.

---

## 4. In-sandbox path contract

The agent never sees host paths. Everything is **cwd-relative**:

| In-sandbox path | Realised by | Access |
|---|---|---|
| `./data/<name>/` | service: bind mount `<cacheRoot>/parquet/<name>/` → `/opt/python/lib/python3.14/site-packages/data/<name>` | read-only (enforced by container) |
| `./` (cwd itself) | service: container working directory | read-write, cleared on exit |
| `/tmp/` (container only) | tmpfs | read-write, cleared on exit |

`path-mapper.ts` exposes:

- `SANDBOX_DATA_DIR = "data"` — the cwd-relative subdir
- `resolveDatasetHostDir(name) → host path` — adapter mount-source
- `maskOutput(text, mapping) → text` — rewrites any host / container absolute paths leaked into stdout / stderr back to cwd-relative form

Reasoning for masking: even a well-behaved Python script that prints a `FileNotFoundError` exposes the absolute path it tried. We unify the LLM's view to `./data/<name>/...` at the output boundary so error feedback round-trips into the next call without translation.

---

## 5. Output handling

Two pieces, both implemented in `output.ts`:

### 5.1 Truncation

| Stream | Cap |
|---|---|
| `stdout` | 20 000 chars |
| `stderr` | 10 000 chars |

Mid-truncation: keep first half + `... [truncated N chars] ...` + last half. Stderr is end-truncated (the most useful info is the trailing exception).

### 5.2 Path masking

Pure string replace, applied longest-prefix-first to avoid nested-substitution corruption. Forms get rewritten per declared dataset (covers ways an absolute path can leak from the service backend):

| Found in stderr / stdout | Rewritten to |
|---|---|
| `<cacheRoot>/parquet/<name>/...` | `./data/<name>/...` |
| `/opt/python/lib/python3.14/site-packages/data/<name>/...` (container absolute) | `./data/<name>/...` |
| `<cacheRoot>/parquet/...` (fallback, undeclared dataset) | `./data/...` |
| `/opt/python/lib/python3.14/site-packages/...` (container cwd) | `./...` |

### 5.3 Termination → structured error

`SandboxOutput.termination` lets the agent tool layer translate to a structured error envelope the LLM can act on:

```json
{ "ok": false, "error": { "code": "TIMEOUT", "message": "..." } }
{ "ok": false, "error": { "code": "OOM", "message": "..." } }
{ "ok": false, "error": { "code": "SECURITY", "message": "syscall blocked" } }
```

The codes are stable across the service backend; an OOM kill from cgroup surfaces as `OOM`.

---

## 6. Agent tool surface

A single tool, registered by the runtime when the agent enables the data-analysis capability:

```ts
run_code_in_sandbox({
  command: ["python3", "-"],
  stdin:
    "import duckdb\n" +
    "df = duckdb.read_parquet('./data/sales_q1_2025/**/*.parquet').df()\n" +
    "print(df.head().to_json())",
  datasets: ["sales_q1_2025"],
  timeoutMs: 30000,
}) → SandboxOutput
```

The dataset is exposed at `./data/sales_q1_2025/` — relative to the sandbox's cwd.

Design notes:

- The tool description tells the LLM the available runtimes (`python3`, later `node`, `bash`) and pre-installed packages — this is generated from the rootfs manifest, so no drift between description and reality.
- The tool description lists currently mountable datasets (queried from the data-source layer), so the LLM picks valid names.
- The tool itself is thin — it forwards to `getActiveAdapter().run(...)`. No business logic in the tool layer.

---

## 7. Hard invariants

1. **`run` is ephemeral.** No state survives between calls. The shared Parquet cache is the only persistence; it is read-only from the sandbox's perspective.
2. **The sandbox has controlled network access.** The service backend can be configured with network access if needed for data fetching operations.
3. **Datasets are read-only mounts.** Even within a single `run`, the script cannot mutate Parquet files.
4. **Path output is masked.** Host paths never appear in `SandboxOutput.stdout` / `stderr` after `output.ts` post-processing.
5. **`command` is argv, never a shell string.** The backend constructs the final command via the shell only when the operator explicitly opts in (e.g., `["bash", "-c", "..."]`); the default is `execve`-direct.

---

## 8. Future / out-of-scope for V1

- **Remote sandbox adapter** (E2B / Daytona / AIO Sandbox). Reconsidered if a workload needs GPU / massive RAM / capabilities the rootfs cannot provide.
- **Session-level sandbox reuse** (long-lived Python REPL). Reconsidered if cold-start cost ever dominates.
- **Multi-language rootfs** (Java, Go). Switch via `SANDBOX_IMAGE` to OpenSandbox or a derived image when needed.
- **User-uploaded untrusted code.** Out of scope until a product feature requires it; would need additional isolation hardening and disabling SubprocessAdapter even in dev.
- **Network-allowed sandboxes** (`pip install` inside the jail). Currently impossible by design — see "non-goals".

---

