# Sandbox Integration Layer

> Audience: backend engineers building code-execution capabilities, contributors adding new isolation backends
> See also: `docs/architecture.md` §3.3, `docs/data-sources.md`

The sandbox integration layer is one of the three peer integration layers in Nango (`docs/architecture.md` §3.3). It hides OS-level isolation diversity behind a single typed contract and exposes a uniform `run` operation to the agent runtime. Its consumers are agents that need to execute generated Python (and later Node.js / shell) for data analysis. Its inputs are the agent's command + Parquet datasets prepared by the data-source layer.

**Status:** Shipped — code lives under `src/lib/sandbox/` (`types.ts`, `errors.ts`, `path-mapper.ts`, `output.ts`, `registry.server.ts`, `runtime-tools.ts`, `index.ts` plus `adapters/{subprocess, local-docker}/`). Two backends are available: **SubprocessAdapter** (degraded fallback, no isolation) and **LocalDockerAdapter** (Docker-based isolation for both dev and production). This document is the as-built reference.

---

## 1. Goals and non-goals

### Goals

- One uniform interface (`ISandboxAdapter`) so the agent tool surface is identical regardless of the underlying isolation tech.
- Two local backends in V1: **Subprocess** (degraded fallback, dev only) and **LocalDocker** (Docker-based isolation for dev and production). Selected explicitly via `SANDBOX_MODE` env var.
- A **cwd-relative path contract** (`./data/<name>/`) so agent-generated code never sees host filesystem paths AND works identically across backends. Both adapters surface declared datasets under the sandbox's working directory — subprocess via symlink, docker via bind mount (`--workdir /work`).
- Hard limits: timeout, memory, CPU. Each backend enforces them with the strongest mechanism it has.
- Output truncation + path masking so a noisy or hostile script cannot flood the agent context or leak host paths.
- Configurable image / rootfs so the data-analysis stack (`python3`, `duckdb`, `pandas`, `numpy`) is one switch away from a multi-language stack later.

### Non-goals (V1)

- Remote sandbox SaaS (E2B, Daytona, AIO). The Parquet shared-cache architecture (`docs/data-sources.md` §4) requires data locality; remote sandboxes break it. Reconsidered post-V1 only if a use case explicitly justifies remote execution.
- Persistent / session-level sandboxes. Every `run()` is ephemeral: process exits → namespace destroyed → tmp cleared. The shared cache is the only persistence mechanism.
- Inter-sandbox communication. Sandboxes never see each other; if two analyses need to share an intermediate, the orchestration is in the agent's sequence of `run` calls, not inside the sandbox.
- Sandboxed script execution as a user-facing primitive ("upload code and run it"). V1's threat model is *agent-generated code* (LLM-controlled, mostly trusted but might have bugs). User-uploaded untrusted code raises the security bar significantly and would force Nsjail / Docker as the only allowed backends.
- GPU / large-memory workloads. The 256 MB / 0.8-CPU envelope targets data analysis at the scale of `pandas.DataFrame`s up to ~10⁶ rows.

---

## 2. The contract

**`SandboxBackend`**: `"subprocess" | "local-docker" | "remote-docker"`

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
                                    # explicit selection via SANDBOX_MODE
  path-mapper.ts                    # virtual ↔ host path resolution + output masking
  output.ts                         # truncate, mask, structured error mapping
  errors.ts                         # SandboxError, BackendUnavailableError, ...
  adapters/
    subprocess/
      adapter.server.ts             # spawn + RSS poll + timer, no isolation
    local-docker/
      adapter.server.ts             # `docker run` argv assembly + image check
docker/sandbox/
  Dockerfile                        # python:3.12-slim + duckdb + pandas + numpy
scripts/
  ensure-sandbox-image.ts           # called from predev / prestart
```

### 3.1 SubprocessAdapter

Pure `child_process.spawn`, no kernel isolation. Used only when Docker is not available (development without Docker Desktop).

- **Path layout**: child cwd is a fresh `mkdtemp` dir. For each declared dataset, the adapter creates `<tmpHostDir>/data/<name>` as a directory symlink to `<cacheRoot>/parquet/<name>/`. In-sandbox code reads `./data/<name>/...` — identical to docker, just realised in user-land instead of kernel-mediated bind mounts.
- **Read-only is unenforced**. Subprocess mode is "degraded" by design — symlinks honour the target dir's permissions, and shared cache dirs default to user-writable. LLM code that writes through `./data/<name>/...` *will* pollute the shared cache. The `local-docker` backend is the only mode that enforces read-only at the kernel level.
- Memory limit via 500 ms RSS polling + SIGKILL on overshoot.
- Timeout via `setTimeout` + SIGKILL.
- Network: clear `http_proxy` / `https_proxy` env vars (a hint to well-behaved libraries; not enforced).
- **Loud at startup**: the registry logs `[sandbox] running in DEGRADED mode — no security boundary` so the operator cannot miss it.

#### Subprocess venv selection

`python3` resolves through the spawned child's `PATH`, which defaults to whatever `python3` ships on the host. To point the subprocess backend at a project venv / pyenv / conda env without leaking the path into agent prompts, set the DB config:

```
sandbox.subprocess.python_path = ~/.pyenv/versions/nango        # pyenv-virtualenv
                                  ~/miniforge3/envs/myenv         # conda / mamba
                                  ~/projects/x/.venv               # plain python3 -m venv
                                  ~/.pyenv/versions/nango/bin/python3   # explicit interpreter
```

Resolution rules (see `resolvePythonVenv` in `adapters/subprocess/adapter.server.ts`):

- Empty / unset → no injection, use system `python3`.
- `~` prefix → home-expanded against `os.homedir()`.
- Path ending in `/bin/python` or `/bin/python3` → treated as the interpreter; venv root inferred as `dirname(dirname(...))`.
- Anything else → treated as the venv root; bin dir is `<root>/bin`; interpreter is `<root>/bin/python3` (falls back to `<root>/bin/python`).

When the config points at a path with no usable interpreter the adapter logs a one-shot warning per misconfigured value and falls back to system PATH — agent calls still succeed (against system `python3`) rather than hard-failing every invocation.

Injection mechanism mirrors `source <venv>/bin/activate`: spawn env gets `VIRTUAL_ENV=<root>`, `PATH=<bin>:$PATH` (bin dir prepended), and `PYTHONHOME` is unset. `argv[0]` is NOT rewritten — PATH injection is enough to make a bare `python3` resolve to the venv, and other commands the LLM might run (`duckdb`, `bash`, …) still fall back to system PATH.

This is a development quality-of-life feature, not a production option.

### 3.2 LocalDockerAdapter

macOS / Linux dev backend. Each call shells out to:

```bash
docker run --rm \
  --network=none \
  --read-only \
  --memory=256m --cpus=0.8 \
  --tmpfs /tmp:exec,size=512m \
  --workdir /work \
  --mount type=bind,src=<tmpHostDir>,dst=/work \
  --mount type=bind,src=<cacheRoot>/parquet/<name>,dst=/work/data/<name>,readonly \
  sandbox-runner:latest \
  python3 -
```

`--workdir /work` makes `/work` the container's cwd, so the LLM-generated Python sees `os.getcwd() == "/work"` and `./data/<name>/...` resolves through the dataset bind mount. The `/work` bind itself is **writable** — LLM can save intermediate files (plots, scratch Parquets) alongside the read-only `./data/<name>/` dirs, matching subprocess parity where `tmpHostDir` is the writable cwd directly. Each declared dataset is bind-mounted with the `readonly` flag, kernel-enforced.

The image is configurable via `SANDBOX_IMAGE` (default `sandbox-runner:latest`). The default Dockerfile builds a minimal Debian-slim image with python3 + the package set in `docker/sandbox/requirements.txt` (~270 MB at the V1 baseline of `duckdb / pandas / numpy`). Operators wanting multi-language support can swap in OpenSandbox's image or a derived image without changing any code.

**Container runtime.** The `local-docker` backend supports both Docker and [Podman](https://podman.io/). Podman's CLI is Docker-compatible; the only difference is the binary name. Set `SANDBOX_RUNTIME=podman` to use Podman instead of Docker. Default is `docker`.

The first `pnpm dev` (or `pnpm start`) calls `scripts/ensure-sandbox-image.ts` which builds the image if absent (using whichever runtime `SANDBOX_RUNTIME` specifies). Subsequent runs are no-ops.

**Python deps are skill-driven.** `requirements.txt` is generated from builtin skills' frontmatter `dependencies-python: [...]` declarations by `pnpm sandbox:build` (which runs `scripts/collect-skill-deps.ts`). Authors who need a new package add it to the relevant `skills/<name>/SKILL.md`, run `pnpm sandbox:build`, and commit the regenerated `requirements.txt` together with the skill change. CI guards against drift via `pnpm sandbox:check`. Do NOT add inline `pip install pkg` lines to the Dockerfile. See `docs/skills.md` §9.x for the design rationale and conflict-detection semantics.

### 3.3 Backend selection — always explicit

Selection is controlled by `sandbox.mode`. **There is no auto-probe and no silent fallback.** The `subprocess` backend has no isolation, so it is **fail-closed by default** (BUG-11): when the resolved mode is `subprocess`, code execution is **refused** (`SandboxDisabledError`) unless the operator explicitly opts in via `sandbox.allow_insecure=true`. A fresh install therefore boots with code execution *disabled* (boot logs a soft warning, not an error) until an operator configures isolation.

| `sandbox.mode` | `sandbox.allow_insecure` | Behaviour |
|---|---|---|
| unset / `subprocess` | `false` (default) | **Code execution disabled** — `getActiveAdapter` throws `SandboxDisabledError`; `run_code_in_sandbox` / `run_skill_script` return a structured "disabled" envelope. |
| `subprocess` | `true` | Subprocess mode — **no isolation**. Explicitly accepted degraded mode (dev / trusted internal). |
| `local-docker` | — | Local Docker daemon. Boot fails if `docker info` fails or the sandbox image is missing. |
| `remote-docker` | — | ⏳ reserved. Not implemented yet — selecting it throws `BackendUnavailableError` at boot. |
| anything else | — | Throws `SandboxError("INVALID_INPUT")` at boot (typo guard). |

**Why no auto-probe**: silent fallback is a security footgun. An operator who set `SANDBOX_MODE=local-docker` in production must NOT silently degrade to `subprocess` (no network or filesystem isolation) just because Docker happened to be down. Failing loudly at boot — with the precise reason — is the only safe default.

Boot emits one log line so the choice is grep-able:
```
[nango] sandbox active backend: local-docker (SANDBOX_MODE=local-docker)
```

`isAvailable()` checks per backend:

- `subprocess`: always true.
- `local-docker`: `docker info` succeeds.
- `remote-docker`: stub adapter (returns null at registry lookup).

The choice is made once at boot (in `instrumentation.ts`); the active adapter is cached for the process lifetime — `_resetActiveAdapterCache()` exists for tests only.

---

## 4. In-sandbox path contract

The agent never sees host paths. Everything is **cwd-relative**:

| In-sandbox path | Realised by | Access |
|---|---|---|
| `./data/<name>/` | subprocess: symlink `<tmpHostDir>/data/<name>` → `<cacheRoot>/parquet/<name>/`<br/>docker: bind mount `<cacheRoot>/parquet/<name>/` → `/work/data/<name>` | read-only (docker enforced; subprocess by convention) |
| `./` (cwd itself) | subprocess: `<tmpHostDir>` directly<br/>docker: bind mount `<tmpHostDir>` → `/work` | read-write, cleared on exit |
| `/tmp/` (docker only) | tmpfs | read-write, cleared on exit |

`path-mapper.ts` exposes:

- `SANDBOX_DATA_DIR = "data"` — the cwd-relative subdir
- `DOCKER_CONTAINER_WORKDIR = "/work"` — container cwd
- `resolveDatasetHostDir(name) → host path` — adapter mount-source
- `maskOutput(text, mapping) → text` — rewrites any host / container absolute paths leaked into stdout / stderr back to cwd-relative form

Reasoning for masking: even a well-behaved Python script that prints a `FileNotFoundError` exposes the absolute path it tried. We unify the LLM's view to `./data/<name>/...` at the output boundary so error feedback round-trips into the next call without translation.

**Why cwd-relative over absolute** (decision D38): an earlier design used `/mnt/cache/<name>/` as the in-sandbox contract — fine in docker (real bind mount at that path) but impossible to fulfil in subprocess (the kernel can't be tricked into having `/mnt/cache` exist without root). The cwd-relative approach works identically in both modes: a symlink under cwd resolves transparently, a bind mount under the container's `--workdir` resolves transparently. Same LLM code runs everywhere.

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

Pure string replace, applied longest-prefix-first to avoid nested-substitution corruption. Three forms get rewritten per declared dataset (covers every way an absolute path can leak across the two backends):

| Found in stderr / stdout | Rewritten to |
|---|---|
| `<cacheRoot>/parquet/<name>/...` (subprocess: symlink target deref) | `./data/<name>/...` |
| `<tmpHostDir>/data/<name>/...` (subprocess: symlink path itself) | `./data/<name>/...` |
| `/work/data/<name>/...` (docker: container absolute) | `./data/<name>/...` |
| `<cacheRoot>/parquet/...` (fallback, undeclared dataset) | `./data/...` |
| `<tmpHostDir>/...` (subprocess: cwd) | `./...` |
| `/work/...` (docker: container cwd) | `./...` |

The mapper holds the per-call `<tmpHostDir>` so replacements target the right dir.

### 5.3 Termination → structured error

`SandboxOutput.termination` lets the agent tool layer translate to a structured error envelope the LLM can act on:

```json
{ "ok": false, "error": { "code": "TIMEOUT", "message": "..." } }
{ "ok": false, "error": { "code": "OOM", "message": "..." } }
{ "ok": false, "error": { "code": "SECURITY", "message": "syscall blocked" } }
```

The codes are stable across backends; an OOM kill from cgroup (Docker) and from RSS polling (Subprocess) both surface as `OOM`.

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

The dataset is exposed at `./data/sales_q1_2025/` — relative to the sandbox's cwd. Works identically across both backends.

Design notes:

- The tool description tells the LLM the available runtimes (`python3`, later `node`, `bash`) and pre-installed packages — this is generated from the rootfs manifest, so no drift between description and reality.
- The tool description lists currently mountable datasets (queried from the data-source layer), so the LLM picks valid names.
- The tool itself is thin — it forwards to `getActiveAdapter().run(...)`. No business logic in the tool layer.

---

## 7. Hard invariants

1. **`run` is ephemeral.** No state survives between calls. The shared Parquet cache is the only persistence; it is read-only from the sandbox's perspective.
2. **The sandbox never has network.** Both backends close it: Docker's `--network=none`, subprocess's env-var hint (the only point where this is best-effort).
3. **Datasets are read-only mounts.** Even within a single `run`, the script cannot mutate Parquet files.
4. **Path output is masked.** Host paths never appear in `SandboxOutput.stdout` / `stderr` after `output.ts` post-processing.
5. **`command` is argv, never a shell string.** Backends construct the final command via the shell only when the operator explicitly opts in (e.g., `["bash", "-c", "..."]`); the default is `execve`-direct.
6. **Subprocess backend is loud.** Any process startup using subprocess logs a single warning line so operators cannot accidentally ship to production with no isolation.

---

## 8. Future / out-of-scope for V1

- **Remote sandbox adapter** (E2B / Daytona / AIO Sandbox). Reconsidered if a workload needs GPU / massive RAM / capabilities the rootfs cannot provide.
- **Session-level sandbox reuse** (long-lived Python REPL). Reconsidered if cold-start cost ever dominates.
- **Multi-language rootfs** (Java, Go). Switch via `SANDBOX_IMAGE` to OpenSandbox or a derived image when needed.
- **User-uploaded untrusted code.** Out of scope until a product feature requires it; would need additional isolation hardening and disabling SubprocessAdapter even in dev.
- **Network-allowed sandboxes** (`pip install` inside the jail). Currently impossible by design — see "non-goals".

---

