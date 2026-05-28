import "server-only";

import { NextResponse } from "next/server";
import {
  EventType,
  HttpAgent,
  type AbstractAgent,
  type AgUiEvent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type Tool,
} from "@/lib/copilot/index.server";
import { Observable } from "rxjs";

import { getAgentCredentialConfigById } from "@/lib/credentials/lookup";
import type { ChatContext } from "./types";

const DEFAULT_ERROR_BODY_MAX_LEN: number = 200;

// Bridge run shell

export interface BridgeRunContext {
  abortSignal: AbortSignal;
  /** Emit typed AG-UI event upstream. Discriminated-union validates per-variant fields without casts. */
  emit: (event: AgUiEvent) => void;
  isCancelled: () => boolean;
}

export interface BridgeRunOptions {
  propagateError: boolean;
}

/**
 * Standard AG-UI bridge run lifecycle with cancellation, sentinels, and
 * error fallback. Provider bridges supply only the `execute` body.
 */
export function createBridgeRunObservable(
  input: RunAgentInput,
  execute: (ctx: BridgeRunContext) => Promise<void>,
  options: BridgeRunOptions = { propagateError: true },
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const abortController: AbortController = new AbortController();
    let cancelled: boolean = false;

    // `BaseEvent` is the wider contract; `AgUiEvent` writes without cast.
    const emit = (event: AgUiEvent): void => {
      if (!cancelled) {
        subscriber.next(event);
      }
    };

    void (async () => {
      try {
        emit({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });

        await execute({
          abortSignal: abortController.signal,
          emit,
          isCancelled: () => cancelled,
        });

        if (!cancelled) {
          emit({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          });
          subscriber.complete();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message: string = error instanceof Error ? error.message : String(error);
        emit({ type: EventType.RUN_ERROR, message });

        if (options.propagateError) {
          subscriber.error(error);
          return;
        }
        subscriber.complete();
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  });
}

/** Preserve subclass config on top of `super.clone()`'s plain result. */
export function attachBridgeConfig<TAgent extends AbstractAgent, TConfig>(
  clonedAgent: TAgent,
  config: TConfig,
): TAgent {
  (clonedAgent as TAgent & { cfg: TConfig }).cfg = config;
  return clonedAgent;
}

// SSE helpers

/** Yield non-empty lines from an SSE response body. */
export async function* readSseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder: TextDecoder = new TextDecoder();
  let buffer: string = "";

  while (true) {
    const { value, done }: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line: string = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        yield line;
      }
    }
  }

  if (buffer.trim()) {
    yield buffer.trim();
  }
}

export async function readShortErrorBody(
  response: Response,
  maxLen: number = DEFAULT_ERROR_BODY_MAX_LEN,
): Promise<string> {
  try {
    const text: string = await response.text();
    return text.slice(0, maxLen);
  } catch {
    return "";
  }
}

/** Throw with a short upstream-body excerpt unless the response is a
 *  valid SSE stream. */
export async function assertValidSseResponse(response: Response): Promise<void> {
  if (response.ok && response.body) {
    return;
  }
  const text: string = await readShortErrorBody(response);
  throw new Error(`Upstream ${response.status} ${response.statusText}: ${text}`);
}

// Credential resolution

export interface BridgeCredentialResolution {
  baseUrl: string;
  apiKey: string;
}

export type BridgeCredentialResult =
  | { ok: true; value: BridgeCredentialResolution }
  | { ok: false; response: Response };

export interface BridgeCredentialErrorMessages {
  notFoundOrDisabled: string;
  missingRestUrl: string;
  missingToken: string;
}

export interface ResolveBridgeCredentialOptions {
  errorMessages?: Partial<BridgeCredentialErrorMessages>;
}

const DEFAULT_BRIDGE_CREDENTIAL_ERROR_MESSAGES: BridgeCredentialErrorMessages = {
  notFoundOrDisabled: "Credential not found or disabled.",
  missingRestUrl: "REST URL is not configured on this credential.",
  missingToken: "Auth token is not configured on this credential.",
};

/**
 * Resolve and validate a backend credential. Returns `{ok, value|response}`
 * so callers surface errors to the Runner without creating run rows.
 */
export async function resolveBridgeCredential(
  credentialId: string,
  options: ResolveBridgeCredentialOptions = {},
): Promise<BridgeCredentialResult> {
  const errorMessages: BridgeCredentialErrorMessages = {
    ...DEFAULT_BRIDGE_CREDENTIAL_ERROR_MESSAGES,
    ...options.errorMessages,
  };

  const credential = await getAgentCredentialConfigById(credentialId);
  if (!credential) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: errorMessages.notFoundOrDisabled },
        { status: 404 },
      ),
    };
  }

  const baseUrl: string = (credential.restUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: errorMessages.missingRestUrl },
        { status: 503 },
      ),
    };
  }

  if (!credential.token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: errorMessages.missingToken },
        { status: 503 },
      ),
    };
  }

  return {
    ok: true,
    value: {
      baseUrl,
      apiKey: credential.token,
    },
  };
}

// AG-UI passthrough fast-path

/**
 * Fast-path for AG-UI-native backends. Returns `null` when `aguiUrl`
 * unconfigured; caller falls through to bridge path.
 *
 * SECURITY: `{agentId}` placeholder is replaced with `encodeURIComponent`.
 * @see docs/backend-integration.md §7
 */
export async function buildPassthroughAgentIfConfigured(
  ctx: ChatContext,
): Promise<AbstractAgent | null> {
  const credential = await getAgentCredentialConfigById(ctx.credentialId);
  if (!credential) return null;
  if (!credential.aguiUrl) return null;
  if (!credential.token) return null;

  const url = credential.aguiUrl.replace(
    "{agentId}",
    encodeURIComponent(ctx.agentId),
  );

  return new HttpAgent({
    url,
    headers: { Authorization: `Bearer ${credential.token}` },
  });
}

// Shared bridge state

/**
 * Tool-call dedupe filter for "Filter mode" bridges (agno, mastra).
 * Dify bypasses via synthesise-result mode.
 * @see docs/backend-integration.md §7
 */
export class ToolCallFilter {
  private readonly declared: Set<string>;
  private readonly forwarded: Set<string> = new Set();

  constructor(tools: readonly Tool[] | undefined) {
    this.declared = new Set((tools ?? []).map((t) => t.name));
  }

  /** First-seen guard for declared tools. Suppresses upstream double-emissions. */
  shouldForwardStart(toolName: string, toolCallId: string): boolean {
    if (!toolName || !toolCallId) return false;
    if (!this.declared.has(toolName)) return false;
    if (this.forwarded.has(toolCallId)) return false;
    this.forwarded.add(toolCallId);
    return true;
  }

  /** Gate ARGS / END / RESULT events on whether the START passed. */
  isForwarded(toolCallId: string): boolean {
    return this.forwarded.has(toolCallId);
  }
}

/**
 * State machine for AG-UI three-stage text protocol.
 * @see docs/backend-integration.md §7
 */
export class TextStreamState {
  private open: boolean = false;

  constructor(
    private readonly emit: (event: AgUiEvent) => void,
    private readonly messageId: string,
  ) {}

  /** Idempotent START emitter. */
  ensureStart(): void {
    if (this.open) return;
    this.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: this.messageId,
      role: "assistant",
    });
    this.open = true;
  }

  /** Emit START (if needed) then CONTENT delta. */
  appendDelta(delta: string): void {
    if (!delta) return;
    this.ensureStart();
    this.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: this.messageId,
      delta,
    });
  }

  /** Idempotent END emitter. Safe in drain handlers. */
  closeIfOpen(): void {
    if (!this.open) return;
    this.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: this.messageId,
    });
    this.open = false;
  }

  get isOpen(): boolean {
    return this.open;
  }
}

// Run-input helpers

/**
 * Extract most recent user text from messages. Multimodal arrays flattened
 * to text parts only (images/files out of scope for v1). Used by upstreams
 * that own session memory (agno, dify).
 */
export function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const c = m.content as unknown;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .map((part) =>
          part &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type: string }).type === "text"
            ? String((part as { text?: string }).text ?? "")
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}


