# Host File Access

> Audience: operators who mount a folder into the Nango container, and engineers extending the host-reach surface
> See also: `docs/config.md` §9 (`host` and `download` groups), `docs/docker-deployment.md`, `docs/guardrails.md`

**Status:** Shipped — code lives under `src/lib/host-files/` (`schema.ts`, `jail.server.ts`, `fs-error.ts`, `runtime-tools.ts`, `ssrf-guard.server.ts`, `download.server.ts`, `download-runtime-tools.ts`), surfaced as the built-in tools `read_file`, `write_file`, `download_file` (`src/lib/builtin-tools/catalog.ts`) plus the auto-mounted `create_folder`.

Nango can give agents a narrow, jail-confined view of one directory on the machine it runs on. The use case is a local-first deployment where an agent reads notes or data dropped into a folder, writes reports back into it, and pulls public files down into it — without ever being able to name a path outside that folder.

---

## 1. Goals and non-goals

### Goals

- **One operator-chosen directory**, nothing else. The jail is `host.file.root`, defaulted to the `/shared_folder` mountpoint that `docker-compose.yaml` ships.
- **Per-agent read/write split.** `read_file`, `write_file` and `download_file` are separate catalog toggles, so an admin can give an agent eyes without hands. `create_folder` is not a toggle: it is mounted automatically beside either write-side tool.
- **Text files in and out.** `read_file` / `write_file` are UTF-8 only, no binary. Anything that arrives as bytes — a `.dsc`, an archive — comes through `download_file` and stays on disk.
- **Hard containment enforced in code**, independent of the OS mount: path neutralization, symlink refusal, and a `realpath` containment check.
- **An optional OS-level guarantee.** Mounting the volume `:ro` makes writes impossible at the kernel, regardless of which agents hold `write_file`.

### Non-goals

- Deleting, renaming or moving files or directories. `write_file` and `download_file` create or replace; `create_folder` adds a directory. Nothing else. To retire a file, overwrite it with a short deprecation note.
- Globbing, search, or recursive listing. An agent discovers paths by listing one directory at a time.
- Append or partial-edit semantics. Every write is a whole-file replacement; every download is a whole-file save with no resume.
- Streaming downloaded content into the conversation. `download_file` returns metadata only — `read_file` is the way to look at text.
- Multi-root or per-agent roots. There is exactly one jail for the whole process.

---

## 2. Configuration

| Key | Default | Meaning |
|---|---|---|
| `host.file.root` | `/shared_folder` | The one directory the tools may touch, as a **container** path. Empty or unreachable makes every call fail with `ROOT_NOT_CONFIGURED`. |
| `host.file.read_max_bytes` | 1048576 | Bytes `read_file` may return per call. Files above it are streamed in line windows rather than buffered whole. |
| `host.file.write_max_bytes` | 1048576 | Bytes `write_file` accepts as one complete file body. |
| `download.max_bytes` | 52428800 | Bytes `download_file` may save (50 MB). Enforced on the stream, not just on `Content-Length`. |
| `download.timeout` | 60 | Seconds for the whole transfer — redirects, headers and body included. One deadline, no per-call override. |
| `download.max_redirects` | 5 | Redirect hops to follow before refusing. |
| `download.allowed_extensions` | `dsc,txt,md,…` | Comma-separated suffixes the **destination** name may end in. Matched against the whole file name, so `tar.gz` is a valid entry. |
| `download.allow_private_network` | `false` | Escape hatch that lets `download_file` reach loopback/private/link-local addresses. Turning it on removes the SSRF guard entirely. |

All of these live in Admin → Config (`docs/config.md` §9, `host` and `download` groups); they are DB rows seeded at boot, not environment variables. The root is read per call, so changing it takes effect without a restart.

`host.file.root` is a path **the Node process can see**. Under Docker that is the container-side mountpoint, not the host directory — which is why the default is `/shared_folder` and the shipped compose file mounts the project's `./shared_folder` there:

```yaml
# docker-compose.yaml → nango-app.volumes
- ./shared_folder:/shared_folder      # shipped read-write; append :ro to deny all writes
# Admin → Config → host.file.root
/shared_folder
```

Bare `pnpm dev` on a machine where `/shared_folder` does not exist simply produces `ROOT_NOT_CONFIGURED`; nothing else in Nango depends on it.

Two operational notes:

- The container runs as uid 1001 (`nextjs`); a read-write mount must be owned or group-writable by it, or every write fails with `READ_ONLY_MOUNT`.
- Mount a dedicated directory. Pointing this at `$HOME`, `/`, or a project checkout hands the agent whatever the mount contains — the jail protects the mount, not your judgement about it.

---

## 3. Tool surface

`read_file`, `write_file` and `download_file` are ordinary catalog entries (`src/lib/builtin-tools/catalog.ts`), so they appear in the agent editor's **Tool** tab and are stored as `builtin_tool` bindings.

`create_folder` is **not** in the catalog. It is synthesized by `buildBuiltinTools` (`src/lib/builtin-tools/index.ts`) whenever the agent holds `write_file` or `download_file`, so it never appears as a checkbox and cannot be switched off on its own. The reason is that those two tools require an existing parent directory and had no way to make one; an agent that can write files can always create a directory inside the same mount, which grants nothing wider. A read-only agent never receives it — that is the read/write permission model, and `tests/unit/lib/builtin-tools/catalog.test.ts` locks it.

**There is deliberately no availability gate.** The tools are always tickable and always saveable, whether or not a folder is mounted, because a mount is a deployment detail the editor cannot observe reliably (it changes with `docker compose up`, not with a user action). The only enforcement is at the call boundary:

- Every tool reads `host.file.root` per execution (`getHostFileRoot()`); an empty or unreachable root returns `ROOT_NOT_CONFIGURED`.
- `EROFS`/`EACCES`/`EPERM` on a read-only volume returns `READ_ONLY_MOUNT`.
- Both messages name the operator's fix sites — the container's `shared_folder` mount and the `host.file.root` config — and tell the agent to report rather than retry. That is the whole teaching mechanism: a misconfigured deployment costs one failed call, not a disabled checkbox and a save-time rejection path.

The accepted trade-off: an agent can hold `write_file` against a `:ro` mount and pay one approval prompt before the call fails. `:ro` remains the strongest guarantee in the design because no binding can override it.

### Risk classification

Registered in `BUILTIN_TOOL_RISK_MAP` (`src/lib/agent-pipeline/risk-registry.ts`):

| Tool | risk | sideEffects | headless |
|---|---|---|---|
| `read_file` | low | read | allowed |
| `write_file` | high | write | **denied** |
| `download_file` | high | write | **denied** |
| `create_folder` | medium | write | allowed |

`write_file` and `download_file` therefore prompt under the default `auto` approval mode and are blocked by G20 Headless Deny in scheduled/async runs. That is intended: the target is the user's real folder, not a sandbox, and `download_file` adds an outbound request to that. An admin who wants a scheduled writer raises it with a tool risk override (Admin → Guardrails).

`create_folder` is deliberately the exception: a non-destructive, idempotent `mkdir` inside the same jail keeps unattended runs working (a scheduled digest can lay out `reports/2026/`), while every tool that puts *content* on disk carries the denial. Without an explicit entry it would inherit the unannotated-tool default anyway; it is registered so the choice is stated rather than accidental.

---

## 4. Path jail

`jail.server.ts` has two entry points, and both return either a contained absolute path plus a canonical root-relative display path, or an error envelope. The threat model is a hostile argument — an LLM whose prompt may have been steered by the content it just read.

- `resolveInJail(root, inputPath, action)` — `read_file`, `write_file`, and `download_file`'s destination. The immediate parent must already exist.
- `resolveCreateInJail(root, inputPath)` — `create_folder`. Containment is proven on the **deepest existing ancestor**, because missing parents are the whole point of the call.

1. **Reject NUL bytes and blank input** → `INVALID_PATH`.
2. **Neutralize re-rooting.** A drive spec or UNC prefix is stripped, then leading separators. `path.resolve(root, rel)` runs on the remainder, so `/notes.md` and `C:/Windows/x` both land *inside* the root instead of escaping it. Stripping separators last matters: the `/Windows/…` remainder of `C:/Windows/…` would otherwise re-root the join on posix.
3. **Refuse a symlinked leaf** (`lstat`) → `PATH_ESCAPE`. Symlinks are never followed: a live link would let a read exfiltrate, and a dangling link would let a write create a file outside the jail.
4. **Prove containment.** `resolveInJail` takes `realpath(parentDir)` and requires it inside `realpath(root)`; a missing parent is a distinct, actionable `NOT_FOUND` whose write-side message names `create_folder`. `resolveCreateInJail` first rejects a lexically outside candidate, then walks up from the leaf until it finds a directory that exists and requires that anchor inside the root — so `root/linkdir/deeper/new` where `linkdir` links out is refused even though nothing below it exists yet.
5. **win32 compare is case-insensitive** and both sides get a trailing separator, so `C:\ROOT` matches `C:\root` while `C:\root-evil` cannot prefix-match `C:\root`.

The root addressed as itself (`""`, `"/"`) short-circuits step 4 in both entry points — its parent is outside the jail by definition.

`download_file` calls the same `jailResolve` as `write_file` before it spends a network request, so the jail stays the single containment authority for every write into the mount.

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
- A target that exists as a directory → `IS_DIRECTORY`; a missing parent → `NOT_FOUND`, whose message names `create_folder`.
- **Atomic replace**: write `<path>.tmp-<uuid>` in the same directory (a cross-filesystem rename is not atomic), then `rename()` over the target. On Windows, renaming onto an existing file fails with `EPERM`/`EEXIST`, so the target is unlinked and the rename retried — a brief absence window is the price of one cross-platform replace. The temp file is removed on any failure path.
- `EROFS` / `EACCES` / `EPERM` map to `READ_ONLY_MOUNT`, whose message tells the agent to inform the user instead of retrying.

---

## 7. Folder semantics

`create_folder` takes a root-relative `path` and returns `{ ok: true, path, created }`.

- Missing parents are created in one call (`mkdir` with `recursive`), so `inbox/debian/current` is a single call.
- **`created: false` is success.** An existing directory — and the root addressed as `""`, `"."` or `"/"`, which reports `path: "."` — returns the same envelope shape, because agents re-issue `mkdir` to "make sure" and a failure there would start a retry loop.
- A leaf occupied by a file → `IS_FILE`. There is no delete or rename, so the message tells the agent to pick a different name.
- The EEXIST that a racing `mkdir -p` can return is reported as `created: false`, not an error.
- Directories cannot be deleted, renamed or moved either. A directory an agent no longer needs stays visible to the user.

---

## 8. Download semantics

`download_file` takes `url`, `target_path` and optional `overwrite`, and returns `{ ok: true, path, sizeBytes, contentType }`.

**The bytes never enter the conversation.** That envelope is the contract (`DownloadOk` in `schema.ts` carries no content field): the file lands on disk and `read_file` is the only way to look at it, which keeps a 50 MB download out of the context window and makes a binary payload a non-event. `target_path` is always chosen by the agent — the file name is never taken from the URL or from `Content-Disposition`, so a server cannot steer where or what gets written.

Gate order in `download-runtime-tools.ts` is deliberate: every refusal that can be decided statically happens **before** the first packet leaves the process.

1. `precheckUrl` — parseable, and `https:` only (`BAD_URL`). A plain-`http` URL is refused rather than upgraded, so the agent sees the fix.
2. `jailResolve(target_path, "write")` — the same containment as `write_file`, including `NOT_FOUND` for a missing parent.
3. Dot-prefixed segments (`.env`, `notes/.hidden.md`) → `PATH_ESCAPE`. A dot directory that does not exist yet is refused a step earlier by the jail; either way the answer is pre-network.
4. Destination extension against `download.allowed_extensions`, matched on the whole lowercased file name so `tar.gz` is one entry and `b.gz` does not inherit it → `TYPE_DENIED`. The message tells the agent that renaming the destination is not an escape, because the guard exists to control what lands, not what it looks like.
5. `lstat` on the target → `IS_DIRECTORY`, or `EXISTS` unless `overwrite: true`. An `EXISTS` refusal leaves the user's bytes untouched and spends no request.

Only then does `download.server.ts` run, with `redirect: "manual"` so every hop is re-checked:

- **Address guard** (`ssrf-guard.server.ts`): the *resolved* address is classified, not the hostname. Loopback, RFC1918, CGNAT, link-local (so `169.254.169.254` metadata), unique-local, multicast, and documentation ranges are refused, in v4 and v6, including IPv4-mapped v6 and zone ids. An unparseable address is refused — fail closed. A redirect that lands internally is blocked exactly like a direct request, which is the common way a hostname-only guard gets walked.
- **Accepted window.** `dns.lookup` and the connection are separate resolvers, so a hostile DNS record can differ between them (a rebinding race). Global `fetch` is kept for the whole transfer — the window is documented here as accepted, and an operator who needs it closed points `download_file` at a network-namespace egress proxy or leaves the tool unmounted. `download.allow_private_network` is not that mitigation: turning it on removes the guard entirely.
- **One deadline** (`AbortSignal.timeout`) covers the redirects, the headers and the body, matching the seconds-unit convention of `sandbox.timeout` and `ssh.exec_timeout`. No per-call timeout argument.
- **Byte budget on the stream.** A declared `Content-Length` above `download.max_bytes` is rejected before anything is written; a lying header is caught by counting bytes in flight (`ByteBudget` transform). Either way nothing is saved.
- **Atomic save, same discipline as `write_file`**: `<target>.tmp-<uuid>` next to the destination, `pipeline` into it, then rename with the Windows clobber retry. A timeout, an aborted body, or an fs failure destroys the stream and removes the temp file, so a failed download never strands a partial file in the user's folder.
- `accept-encoding: identity` is sent because the bytes are stored verbatim — a transparently gzipped body would land labelled `.dsc` and never open.

Unit tests stub `fetch` with a real `Response` over a real `ReadableStream`, so the pipeline, backpressure, abort and rename paths are the production ones; socket and TLS behavior is covered by the manual acceptance run.

---

## 9. Error codes

Every failure returns `{ ok: false, error, message }` — no tool ever throws (`AGENTS.md` rule 19).

| Code | Meaning | Agent guidance |
|---|---|---|
| `ROOT_NOT_CONFIGURED` | `host.file.root` empty, or the configured container path is not mounted | Report the mount check; do not retry |
| `INVALID_PATH` | NUL byte or blank input | Fix the argument |
| `PATH_ESCAPE` | Resolved outside the root, the target is a symlink, or a dot-prefixed download target | Do not retry with another spelling |
| `NOT_FOUND` | Path or parent directory missing | `create_folder` for a write target; otherwise list the parent |
| `IS_DIRECTORY` | Write or download target is a directory | Provide a file path |
| `IS_FILE` | `create_folder` target is occupied by a file | Choose a different name — there is no delete |
| `NOT_TEXT` | Not valid UTF-8 | Never retry — `read_file` handles text only |
| `TOO_LARGE` | `write_file` body or `download_file` response over its budget | Split the content, or ask the user for a smaller file |
| `READ_ONLY_MOUNT` | Volume mounted `:ro` or permissions deny it | Tell the user, do not retry |
| `READ_FAILED` | Underlying filesystem error while reading | One retry at most |
| `WRITE_FAILED` | Underlying filesystem error while writing, or a missing download parent | Report it; state may be unchanged |
| `BAD_URL` | Not an absolute `https://` URL, or too many redirects | Pass the full https form |
| `SSRF_BLOCKED` | Host resolves to a private/loopback/link-local address, directly or via a redirect | Do not retry another spelling; tell the user |
| `TYPE_DENIED` | Destination extension not in `download.allowed_extensions` | An admin widens the list; renaming is not an escape |
| `EXISTS` | `download_file` target exists without `overwrite: true` | Its bytes are untouched; ask before replacing |
| `HTTP_STATUS` | Non-2xx response | Nothing was saved — an error page is never stored as a file |
| `TIMEOUT` | Transfer did not finish inside `download.timeout` | Nothing was saved; do not retry the same URL unchanged |
| `NET_FAILED` | DNS, TLS, or connection failure | Report it; a retry is rarely worth it |
