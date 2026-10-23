# Host File Access

> Audience: operators who mount a folder into the Nango container, and engineers extending the host-reach surface
> See also: `docs/config.md` §9 (`host` group), `docs/docker-deployment.md`, `docs/guardrails.md`

**Status:** Shipped — code lives under `src/lib/host-files/` (`schema.ts`, `jail.server.ts`, `runtime-tools.ts`), surfaced as the built-in tools `read_file` and `write_file` (`src/lib/builtin-tools/catalog.ts`).

Nango can give agents a narrow, jail-confined view of one directory on the machine it runs on. The use case is a local-first deployment where an agent reads notes or data dropped into a folder and writes reports back into it — without ever being able to name a path outside that folder.

---

## 1. Goals and non-goals

### Goals

- **One operator-chosen directory**, nothing else. The jail is `host.file.root`, defaulted to the `/shared_folder` mountpoint that `docker-compose.yaml` ships.
- **Per-agent read/write split.** `read_file` and `write_file` are separate catalog toggles, so an agent can be given eyes without hands.
- **Text files only.** UTF-8 in, UTF-8 out. No binary reads, no attachments.
- **Hard containment enforced in code**, independent of the OS mount: path neutralization, symlink refusal, and a `realpath` containment check.
- **An optional OS-level guarantee.** Mounting the volume `:ro` makes writes impossible at the kernel, regardless of which agents hold `write_file`.

### Non-goals

- Deleting, renaming or moving files. `write_file` creates or replaces; nothing else. To retire a file, overwrite it with a short deprecation note.
- Directory creation, globbing, search, or recursive listing. An agent discovers paths by listing one directory at a time.
- Append or partial-edit semantics. Every write is a whole-file replacement.
- Multi-root or per-agent roots. There is exactly one jail for the whole process.

---

## 2. Configuration

| Key | Default | Meaning |
|---|---|---|
| `host.file.root` | `/shared_folder` | The one directory the tools may touch, as a **container** path. Empty or unreachable makes every call fail with `ROOT_NOT_CONFIGURED`. |
| `host.file.read_max_bytes` | 1048576 | Bytes `read_file` may return per call. Files above it are streamed in line windows rather than buffered whole. |
| `host.file.write_max_bytes` | 1048576 | Bytes `write_file` accepts as one complete file body. |

All three live in Admin → Config (`docs/config.md`); they are DB rows seeded at boot, not environment variables. The root is read per call, so changing it takes effect without a restart.

`host.file.root` is a path **the Node process can see**. Under Docker that is the container-side mountpoint, not the host directory — which is why the default is `/shared_folder` and the shipped compose file mounts the project's `./shared_folder` there:

```yaml
# docker-compose.yaml → nango-app.volumes
- ./shared_folder:/shared_folder:ro   # drop :ro for writers
# Admin → Config → host.file.root
/shared_folder
```

Bare `pnpm dev` on a machine where `/shared_folder` does not exist simply produces `ROOT_NOT_CONFIGURED`; nothing else in Nango depends on it.

Two operational notes:

- The container runs as uid 1001 (`nextjs`); a read-write mount must be owned or group-writable by it, or every write fails with `READ_ONLY_MOUNT`.
- Mount a dedicated directory. Pointing this at `$HOME`, `/`, or a project checkout hands the agent whatever the mount contains — the jail protects the mount, not your judgement about it.

---

## 3. Tool surface

`read_file` and `write_file` are ordinary catalog entries (`src/lib/builtin-tools/catalog.ts`), so they appear in the agent editor's **Tool** tab and are stored as `builtin_tool` bindings.

**There is deliberately no availability gate.** The tools are always tickable and always saveable, whether or not a folder is mounted, because a mount is a deployment detail the editor cannot observe reliably (it changes with `docker compose up`, not with a user action). The only enforcement is at the call boundary:

- Both tools read `host.file.root` per execution (`getHostFileRoot()`); an empty or unreachable root returns `ROOT_NOT_CONFIGURED`.
- `EROFS`/`EACCES`/`EPERM` on a read-only volume returns `READ_ONLY_MOUNT`.
- Both messages name the operator's fix sites — the container's `shared_folder` mount and the `host.file.root` config — and tell the agent to report rather than retry. That is the whole teaching mechanism: a misconfigured deployment costs one failed call, not a disabled checkbox and a save-time rejection path.

The accepted trade-off: an agent can hold `write_file` against a `:ro` mount and pay one approval prompt before the call fails. `:ro` remains the strongest guarantee in the design because no binding can override it.

### Risk classification

Registered in `BUILTIN_TOOL_RISK_MAP` (`src/lib/agent-pipeline/risk-registry.ts`):

| Tool | risk | sideEffects | headless |
|---|---|---|---|
| `read_file` | low | read | allowed |
| `write_file` | high | write | **denied** |

`write_file` therefore prompts under the default `auto` approval mode and is blocked by G20 Headless Deny in scheduled/async runs. That is intended: the target is the user's real folder, not a sandbox. An admin who wants a scheduled writer raises it with a tool risk override (Admin → Guardrails).

---

## 4. Path jail

`resolveInJail(root, inputPath, action)` in `src/lib/host-files/jail.server.ts` returns either a contained absolute path plus a canonical root-relative display path, or an error envelope. The threat model is a hostile argument — an LLM whose prompt may have been steered by the content it just read.

1. **Reject NUL bytes and blank input** → `INVALID_PATH`.
2. **Neutralize re-rooting.** A drive spec or UNC prefix is stripped, then leading separators. `path.resolve(root, rel)` runs on the remainder, so `/notes.md` and `C:/Windows/x` both land *inside* the root instead of escaping it. Stripping separators last matters: the `/Windows/…` remainder of `C:/Windows/…` would otherwise re-root the join on posix.
3. **Refuse a symlinked leaf** (`lstat`) → `PATH_ESCAPE`. Symlinks are never followed: a live link would let a read exfiltrate, and a dangling link would let a write create a file outside the jail.
4. **Prove containment on the parent.** `realpath(parentDir)` must be inside `realpath(root)`. Checking the parent rather than the leaf catches an intermediate directory that links outside, and works when the leaf does not exist yet (the write path). A missing parent is a distinct, actionable `NOT_FOUND` — the tool does not create directories.
5. **win32 compare is case-insensitive** and both sides get a trailing separator, so `C:\ROOT` matches `C:\root` while `C:\root-evil` cannot prefix-match `C:\root`.

The root addressed as itself (`""`, `"/"`) short-circuits step 4 — its parent is outside the jail by definition.

---

## 5. Read semantics

`read_file` takes `path`, optional `offset` (1-based line) and `limit` (default 500, max 2000). A directory path returns a listing instead of content.

- **Directory**: `{ kind: "directory", entries: [{ name, kind, sizeBytes?, modifiedAt? }] }`, directories first then names ascending, capped at 500 entries with `truncated: true`. Symlinks and special files are dropped rather than listed — the jail refuses them, so surfacing them only invites retries.
- **File at or below `host.file.read_max_bytes`**: read as one buffer, validated with `isUtf8` from `node:buffer`, normalized CRLF/CR → LF, then windowed by line. `truncated` is exact.
- **Larger file**: streamed through `readline`, collecting only the requested window and never buffering the file. Invalid UTF-8 is detected by a U+FFFD replacement character in the window; `truncated` means the window stopped before end-of-stream.
- **Offset past EOF** succeeds with an empty window rather than erroring — the agent already knows the file exists.

Envelope: `{ ok: true, kind: "file", path, content, sizeBytes, modifiedAt, startLine, endLine, truncated }`.

---

## 6. Write semantics

`write_file` takes `path` and the complete new `content`. It returns `{ ok: true, path, sizeBytes, modifiedAt, created }`, where `created` distinguishes a new file from a replacement.

- The byte budget is checked before touching disk.
- A target that exists as a directory → `IS_DIRECTORY`; a missing parent → `NOT_FOUND`.
- **Atomic replace**: write `<path>.tmp-<uuid>` in the same directory (a cross-filesystem rename is not atomic), then `rename()` over the target. On Windows, renaming onto an existing file fails with `EPERM`/`EEXIST`, so the target is unlinked and the rename retried — a brief absence window is the price of one cross-platform replace. The temp file is removed on any failure path.
- `EROFS` / `EACCES` / `EPERM` map to `READ_ONLY_MOUNT`, whose message tells the agent to inform the user instead of retrying.

---

## 7. Error codes

Every failure returns `{ ok: false, error, message }` — no tool ever throws (`AGENTS.md` rule 19).

| Code | Meaning | Agent guidance |
|---|---|---|
| `ROOT_NOT_CONFIGURED` | `host.file.root` empty, or the configured container path is not mounted | Report the mount check; do not retry |
| `INVALID_PATH` | NUL byte or blank input | Fix the argument |
| `PATH_ESCAPE` | Resolved outside the root, or the target is a symlink | Do not retry with another spelling |
| `NOT_FOUND` | Path or parent directory missing | List the parent first |
| `IS_DIRECTORY` | `write_file` target is a directory | Provide a file path |
| `NOT_TEXT` | Not valid UTF-8 | Never retry — text files only |
| `TOO_LARGE` | `write_file` body over `host.file.write_max_bytes` | Split the content |
| `READ_ONLY_MOUNT` | Volume mounted `:ro` or permissions deny it | Tell the user, do not retry |
| `READ_FAILED` | Underlying filesystem error while reading | One retry at most |
| `WRITE_FAILED` | Underlying filesystem error while writing | Report it; state may be unchanged |
