/**
 * Coalesce raw `entity_run_event` rows into the `ToolInvocation[]`
 * shape that the W1.5 save pipeline (`build-from-events.ts`)
 * consumes.
 *
 * The runner emits events at the AG-UI stream level (`tool_call_chunk`
 * for incremental arg streaming + `tool_call_result` for completion).
 * Save-time analysis wants one logical "invocation" per tool call.
 * This helper does the grouping + JSON parsing.
 *
 * Event shape (from `src/lib/runner/types.ts`):
 *   - tool_call_chunk:   { toolCallId, toolName, args: string }
 *   - tool_call_result:  { toolCallId, content: string }
 *
 * `args` is JSON-incrementally streamed (Vercel AI SDK convention) —
 * we concatenate chunks for the same `toolCallId` in `seq` order,
 * then JSON.parse the result. Same for `content` on the result
 * event.
 *
 * Failure handling:
 *   - If chunks for a call never produced a result event → ok=false,
 *     result=null (tool may have failed mid-stream).
 *   - If result `content` parses but isn't an object → ok=true,
 *     result wrapped as `{ value: <parsed> }`.
 *   - If `content` doesn't parse as JSON → ok=false, result=null
 *     (defensive — shouldn't happen but we don't want to crash the
 *     save pipeline on malformed event data).
 *
 * Pure function — no DB, no I/O. Caller (save-artifact.ts) is
 * responsible for loading the events.
 */

import type { ToolInvocation } from "@/lib/workflows";

// ─── Public surface ────────────────────────────────────────────────────

/** Subset of `EntityRunEventEntity` fields the coalescer needs.
 *
 *  `runId` is optional and only meaningful when the caller is
 *  feeding events from MULTIPLE runs (e.g. all runs in a chat
 *  thread). When present, the coalescer pins each toolCallId to
 *  the first run that introduced its chunks and ignores chunks
 *  with the same toolCallId from other runs (LLM-context replay
 *  in a follow-up turn re-emits the same chunks; without this
 *  guard, args would be double-concatenated). Result events still
 *  follow the existing "first non-empty wins" rule, regardless of
 *  which run produced them — that's exactly the cross-run pairing
 *  we want for the chat-Save flow (chunks in turn N, results in
 *  turn N+1). */
export interface RawRunEvent {
  seq: number;
  type: string;
  payload: unknown;
  runId?: string;
}

export function coalesceToolCalls(
  events: ReadonlyArray<RawRunEvent>,
): ToolInvocation[] {
  // Sort by seq just in case the caller didn't. Stable.
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // Accumulate chunks per toolCallId in encounter order.
  const buckets = new Map<string, ChunkBucket>();

  for (const event of sorted) {
    if (event.type === "tool_call_chunk") {
      const chunk = readChunkPayload(event.payload);
      if (chunk === null) continue;
      let bucket = buckets.get(chunk.toolCallId);
      if (bucket === undefined) {
        bucket = {
          callId: chunk.toolCallId,
          toolName: chunk.toolName,
          seq: event.seq,
          runId: event.runId,
          argsParts: [],
          rawResult: undefined,
        };
        buckets.set(chunk.toolCallId, bucket);
      } else if (
        bucket.runId !== undefined &&
        event.runId !== undefined &&
        event.runId !== bucket.runId
      ) {
        // Cross-run replay: same toolCallId, different run. Ignore
        // — the chunks are already accumulated from the originating
        // run; re-applying them would double-concatenate the args.
        continue;
      }
      // First non-empty toolName wins (typically chunks share the same name).
      if (bucket.toolName.length === 0 && chunk.toolName.length > 0) {
        bucket.toolName = chunk.toolName;
      }
      bucket.argsParts.push(chunk.args);
      continue;
    }
    if (event.type === "tool_call_result") {
      const res = readResultPayload(event.payload);
      if (res === null) continue;
      const bucket = buckets.get(res.toolCallId);
      // A result without any chunks would be unusual — skip
      // (toolCallId we don't recognise has no input to record).
      if (bucket === undefined) continue;
      bucket.rawResult = res.content;
    }
  }

  // Materialise invocations in chunk-encounter order (matches
  // chronological order of when the call started streaming).
  //
  // `ok` reflects SEMANTIC success, not just "result JSON parsed".
  // Nango tools follow the envelope convention
  // `{ ok: true, ...payload } | { ok: false, error: {...} }`
  // (see `docs/tool-conventions.md` and any builtin tool's
  // `execute()` for examples). A failed-envelope result is
  // pipelinewise indistinguishable from a tool that wasn't run:
  // it produced no usable output, downstream nodes cannot
  // reference it, and the save pipeline must skip it via
  // `successful.filter(i => i.ok)`. Without this rule, failed
  // invocations (e.g. POLICY_VIOLATION on extract_dataset_by_sql,
  // EXTRACT_FAILED on a connection blip) get captured as workflow
  // nodes and the refreshed workflow re-runs them — guaranteed to
  // fail the same way they did originally.
  const invocations: ToolInvocation[] = [];
  for (const bucket of buckets.values()) {
    const input = parseArgs(bucket.argsParts);
    let result: Record<string, unknown> | null = null;
    let ok = false;
    if (bucket.rawResult !== undefined) {
      const parsed = parseResult(bucket.rawResult);
      if (parsed.ok && !isFailedEnvelope(parsed.value)) {
        ok = true;
        result = parsed.value;
      }
    }
    invocations.push({
      callId: bucket.callId,
      seq: bucket.seq,
      toolName: bucket.toolName,
      input,
      result,
      ok,
    });
  }
  return invocations;
}

/**
 * Detect tool result envelopes that signal semantic failure.
 *
 * Two shapes are recognised:
 *
 *  1. The Nango "ok envelope" — `{ ok: false, error: {...} }`.
 *     Standard convention across `extract_dataset_by_sql`,
 *     `web_search`, and most server-side builtin tools.
 *
 *  2. The process-result envelope — `{ exitCode, stdout, stderr,
 *     durationMs, backend }`. Used by `run_code_in_sandbox` and
 *     any future shell-like tool: a non-zero numeric `exitCode`
 *     means the underlying process aborted (e.g. Python
 *     `ModuleNotFoundError`, traceback, OOM). The tool itself
 *     returned a parseable JSON object, but the work inside it
 *     failed — semantically equivalent to `ok: false` for the
 *     purposes of "should this call become a workflow node?".
 *
 * Anything else (no `ok`, no numeric `exitCode`, both
 * indicating success) is treated as success. Tools that don't
 * fit either shape pass through unchanged.
 *
 * The `exitCode` branch is a TARGETED TRANSITIONAL CHECK. The
 * cleaner long-term fix is to migrate `run_code_in_sandbox` (and
 * peers) to the `{ ok, ... }` envelope so this helper only has
 * to know about one shape. Once that lands, the exitCode branch
 * can be deleted with no behavioural change for `ok`-envelope
 * users.
 */
function isFailedEnvelope(value: Record<string, unknown>): boolean {
  if (value.ok === false) return true;
  const exitCode = value.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  return false;
}

// ─── Internals ─────────────────────────────────────────────────────────

interface ChunkBucket {
  callId: string;
  toolName: string;
  /** seq of the FIRST chunk — used as chronological position. */
  seq: number;
  /** runId of the FIRST chunk — anchors cross-run replay dedupe.
   *  Undefined when the caller did not supply `runId` on the event
   *  (single-run callers), in which case dedupe is disabled. */
  runId: string | undefined;
  argsParts: string[];
  rawResult: string | undefined;
}

interface ChunkPayload {
  toolCallId: string;
  toolName: string;
  args: string;
}

interface ResultPayload {
  toolCallId: string;
  content: string;
}

function readChunkPayload(payload: unknown): ChunkPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const toolCallId = readString(p.toolCallId);
  const toolName = readString(p.toolName);
  const args = readString(p.args);
  if (toolCallId === null || toolName === null || args === null) return null;
  return { toolCallId, toolName, args };
}

function readResultPayload(payload: unknown): ResultPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const toolCallId = readString(p.toolCallId);
  const content = readString(p.content);
  if (toolCallId === null || content === null) return null;
  return { toolCallId, content };
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Concatenate streamed args parts and parse as JSON. Returns an
 * empty object on any failure — tools with empty / malformed args
 * still produce a valid invocation (the save pipeline can decide
 * what to do).
 */
function parseArgs(parts: string[]): Record<string, unknown> {
  const joined = parts.join("");
  if (joined.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(joined) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

interface ParsedResult {
  ok: boolean;
  value: Record<string, unknown>;
}

/**
 * Parse the result-event `content` string as JSON. If it parses
 * to a non-object (primitive / array), wrap as `{ value: <parsed> }`
 * so downstream consumers always get `Record<string, unknown>`.
 * Returns `ok: false` for unparseable content.
 */
function parseResult(content: string): ParsedResult {
  if (content.trim().length === 0) return { ok: false, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, value: {} };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: true, value: { value: parsed } };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
