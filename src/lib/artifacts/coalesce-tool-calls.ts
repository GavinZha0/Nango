/**
 * Coalesce raw `entity_run_event` rows into `ToolInvocation[]` for
 * the save pipeline. Pure — no DB, no I/O. The `args` and `content`
 * fields are JSON-streamed; chunks with the same `toolCallId` are
 * concatenated in `seq` order then parsed. See docs/workflow.md.
 */

import type { ToolInvocation } from "@/lib/workflows";

// ─── Public surface ────────────────────────────────────────────────────

/** Subset of `EntityRunEventEntity` fields the coalescer needs.
 *  `runId` is optional and only used for cross-run dedupe: chunks
 *  whose toolCallId already appeared in an earlier run are ignored
 *  (LLM replay would otherwise double-concatenate args). Result
 *  events are still paired across runs (chunks in turn N, results
 *  in turn N+1 is the typical chat-Save shape). */
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
        // — re-applying chunks would double-concatenate the args.
        continue;
      }
      // First non-empty toolName wins (chunks typically share the same name).
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
      // A result without any chunks is unusual — skip.
      if (bucket === undefined) continue;
      bucket.rawResult = res.content;
    }
  }

  // `ok` reflects SEMANTIC success — failed-envelope invocations
  // ({ ok: false, ... } or non-zero exitCode) MUST be skipped by
  // the save pipeline so they're not captured as workflow nodes.
  // See `isFailedEnvelope` below.
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
 * Recognise the two failure envelopes produced by current tools:
 * the Nango "ok envelope" (`{ ok: false, ... }`) and the
 * process-result envelope (non-zero `exitCode` from
 * `run_code_in_sandbox`).
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
 * still produce a valid invocation.
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
 * Parse the result-event `content` string as JSON. Non-object
 * results (primitive / array) are wrapped as `{ value: <parsed> }`
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
