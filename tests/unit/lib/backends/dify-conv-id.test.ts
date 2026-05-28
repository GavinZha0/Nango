import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lastValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";

vi.mock("server-only", () => ({}));

// Stub thread-state DAO so we control persisted conv_id without touching the DB.
const getThreadProviderState = vi.fn();
const setThreadProviderState = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/backends/thread-state.server", () => ({
  getThreadProviderState,
  setThreadProviderState,
}));

// Capture every fetch call so we can assert body shape per attempt.
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  getThreadProviderState.mockReset();
  setThreadProviderState.mockClear();
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const { DifyBridgeAgent } = await import("@/lib/backends/dify/chat.server");
type Agent = InstanceType<typeof DifyBridgeAgent>;

const CRED_ID = "00000000-0000-0000-0000-000000000001";
const THREAD_ID = "thread-abc";
const USER_ID = "user-xyz";

function makeAgent(): Agent {
  return new DifyBridgeAgent({
    baseUrl: "https://dify.example.com/v1",
    apiKey: "sk-test",
    credentialId: CRED_ID,
  });
}

function makeInput(threadId: string = THREAD_ID): Parameters<Agent["run"]>[0] {
  return {
    threadId,
    runId: "run-1",
    messages: [{ id: "m1", role: "user", content: "hello" }],
    tools: [],
    state: {},
    context: [],
    forwardedProps: { user_id: USER_ID },
  } as Parameters<Agent["run"]>[0];
}

/** Minimal SSE body that completes the bridge cleanly with a captured conv_id. */
function sseResponse(convId: string, status: number = 200): Response {
  const body =
    `data: ${JSON.stringify({ event: "message", answer: "hi", message_id: "msg1" })}\n\n` +
    `data: ${JSON.stringify({ event: "message_end", conversation_id: convId })}\n\n`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function errorResponse(status: number): Response {
  return new Response("not found", { status });
}

/** Drain the agent's observable to completion so we can inspect fetch calls. */
async function drain(agent: Agent, input: Parameters<Agent["run"]>[0]): Promise<void> {
  await lastValueFrom(agent.run(input).pipe(toArray()));
}

function bodyOfCall(callIndex: number): Record<string, unknown> {
  const args = fetchMock.mock.calls[callIndex];
  const init = args[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("Dify conversation_id strategy", () => {
  it("omits conversation_id entirely on the first message of a brand-new thread", async () => {
    getThreadProviderState.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(sseResponse("conv-fresh"));

    await drain(makeAgent(), makeInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = bodyOfCall(0);
    expect(body).not.toHaveProperty("conversation_id");
    expect(body.query).toBe("hello");
  });

  it("does NOT retry when the first omit-conv_id request 4xxs (genuine error)", async () => {
    getThreadProviderState.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(errorResponse(400));

    // Bridge propagates the upstream error via createBridgeRunObservable's RUN_ERROR.
    await expect(drain(makeAgent(), makeInput())).rejects.toThrow();

    // Critically: only ONE fetch call. The retry path is gated on `mapped`
    // being defined — without a known conv_id there is nothing to drop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = bodyOfCall(0);
    expect(body).not.toHaveProperty("conversation_id");
  });

  it("sends persisted conversation_id when a mapping exists", async () => {
    getThreadProviderState.mockResolvedValueOnce({ convId: "conv-known" });
    fetchMock.mockResolvedValueOnce(sseResponse("conv-known"));

    await drain(makeAgent(), makeInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOfCall(0).conversation_id).toBe("conv-known");
  });

  it("retries WITHOUT conversation_id on 404 only when a mapping was sent (stale-mapping case)", async () => {
    getThreadProviderState.mockResolvedValueOnce({ convId: "conv-stale" });
    fetchMock
      .mockResolvedValueOnce(errorResponse(404))
      .mockResolvedValueOnce(sseResponse("conv-replacement"));

    await drain(makeAgent(), makeInput());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOfCall(0).conversation_id).toBe("conv-stale");
    expect(bodyOfCall(1)).not.toHaveProperty("conversation_id");

    // The replacement conv_id must be persisted via the DAO.
    expect(setThreadProviderState).toHaveBeenCalledWith(
      CRED_ID,
      THREAD_ID,
      "dify",
      { convId: "conv-replacement" },
    );
  });
});
