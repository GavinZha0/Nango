/**
 * Unit tests for src/lib/mcp/tasks-client.server.ts.
 *
 * Two layers:
 *   1. `buildTaskSessionOptions` / `rawDispatch` run against a REAL SDK
 *      `Client` connected over `InMemoryTransport` to a hand-rolled fake
 *      server. `rawDispatch` reaches into SDK-private fields
 *      (`_responseHandlers`, `_requestMessageId`); these tests are the
 *      contract tripwire that fails first when an SDK upgrade moves them.
 *   2. `createTaskSession` / `listServerTasks` / `getServerTask` /
 *      `cancelServerTask` run with `withMcpAdminClient` and the ext-tasks
 *      session factory mocked, pinning our own branching logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withMcpAdminClientMock, createTaskSessionFromClientMock } = vi.hoisted(() => ({
  withMcpAdminClientMock: vi.fn(),
  createTaskSessionFromClientMock: vi.fn(),
}));

vi.mock("@/lib/mcp/admin-client.server", () => ({
  withMcpAdminClient: withMcpAdminClientMock,
}));

vi.mock("@modelcontextprotocol/ext-tasks/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/ext-tasks/client")>();
  return {
    ...actual,
    createTaskSessionFromClient: createTaskSessionFromClientMock,
  };
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ClientCapabilities, JSONRPCMessage } from "@modelcontextprotocol/client";

import {
  buildTaskSessionOptions,
  cancelServerTask,
  createTaskSession,
  getServerTask,
  listServerTasks,
} from "@/lib/mcp/tasks-client.server";

const CLIENT_INFO = { name: "nango-test", version: "1.0.0" };
const CLIENT_CAPS: ClientCapabilities = {
  roots: { listChanged: true },
  extensions: { "x-other/ext": { enabled: true } },
};
const V2_VERSION = "2026-07-28";

// Fake upstream server over InMemoryTransport

type JsonRecord = Record<string, unknown>;
type RequestHandler = (req: JsonRecord) => JsonRecord | "no-reply";

interface FakeServer {
  client: Client;
  /** Every request the server received, in arrival order. */
  received: JsonRecord[];
  /** Per-method handler; return a JSON-RPC response body (without id/jsonrpc) or "no-reply". */
  handlers: Map<string, RequestHandler>;
  close(): Promise<void>;
}

async function connectFakeServer(): Promise<FakeServer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const received: JsonRecord[] = [];
  const handlers = new Map<string, RequestHandler>();

  serverTransport.onmessage = (message: JSONRPCMessage) => {
    const msg = message as unknown as JsonRecord;
    if (typeof msg.method !== "string" || msg.id === undefined) return; // notifications
    received.push(msg);

    if (msg.method === "initialize") {
      const params = (msg.params ?? {}) as JsonRecord;
      void serverTransport.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: {},
          serverInfo: { name: "fake-server", version: "0.0.1" },
        },
      } as unknown as JSONRPCMessage);
      return;
    }

    const handler = handlers.get(msg.method);
    const body: JsonRecord | "no-reply" = handler
      ? handler(msg)
      : msg.method === "ping"
        ? { result: {} }
        : { error: { code: -32601, message: `Method not found: ${msg.method}` } };
    if (body === "no-reply") return;
    void serverTransport.send({ jsonrpc: "2.0", id: msg.id, ...body } as unknown as JSONRPCMessage);
  };
  await serverTransport.start();

  const client = new Client(CLIENT_INFO, {
    versionNegotiation: { mode: "legacy" },
    capabilities: CLIENT_CAPS,
  });
  await client.connect(clientTransport);

  return {
    client,
    received,
    handlers,
    close: () => client.close(),
  };
}

/** Pretend the connected client negotiated the 2026-07-28 (modern) era. */
function forceModernEra(client: Client, version: string | null = V2_VERSION): void {
  vi.spyOn(client, "getProtocolEra").mockReturnValue("modern" as ReturnType<Client["getProtocolEra"]>);
  vi.spyOn(client, "getNegotiatedProtocolVersion").mockReturnValue(version ?? undefined);
}

function responseHandlersOf(client: Client): Map<number, unknown> {
  return (client as unknown as { _responseHandlers: Map<number, unknown> })._responseHandlers;
}

// 1. buildTaskSessionOptions + rawDispatch (real SDK client)

describe("buildTaskSessionOptions", () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await connectFakeServer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("returns undefined for a legacy-era connection", () => {
    expect(server.client.getProtocolEra()).not.toBe("modern");
    expect(buildTaskSessionOptions(server.client, CLIENT_INFO, CLIENT_CAPS)).toBeUndefined();
  });

  it("returns undefined when modern era has no negotiated protocol version", () => {
    forceModernEra(server.client, null);
    expect(buildTaskSessionOptions(server.client, CLIENT_INFO, CLIENT_CAPS)).toBeUndefined();
  });

  it("builds V2 framing that preserves declared capabilities and adds the tasks extension", () => {
    forceModernEra(server.client);
    const opts = buildTaskSessionOptions(server.client, CLIENT_INFO, CLIENT_CAPS);
    expect(opts).toBeDefined();
    expect(opts!.v2RequestFraming).toEqual({
      protocolVersion: V2_VERSION,
      clientInfo: CLIENT_INFO,
      clientCapabilities: {
        roots: { listChanged: true },
        extensions: {
          "x-other/ext": { enabled: true },
          "io.modelcontextprotocol/tasks": {},
        },
      },
    });
    expect(typeof opts!.rawDispatch).toBe("function");
  });

  describe("rawDispatch (SDK-internals contract)", () => {
    function getRawDispatch() {
      forceModernEra(server.client);
      return buildTaskSessionOptions(server.client, CLIENT_INFO, CLIENT_CAPS)!.rawDispatch;
    }

    it("SDK still exposes the private fields rawDispatch depends on", () => {
      // CONTRACT: if this fails after an SDK upgrade, rawDispatch must be
      // re-ported — do NOT just relax the assertion.
      const internal = server.client as unknown as {
        _responseHandlers?: unknown;
        _requestMessageId?: unknown;
      };
      expect(internal._responseHandlers).toBeInstanceOf(Map);
      expect(typeof internal._requestMessageId).toBe("number");
      expect(server.client.transport).toBeDefined();
    });

    it("passes V2 results through untouched (resultType: task is not stripped or rejected)", async () => {
      const taskResult = {
        resultType: "task",
        task: { taskId: "task-abc", status: "working", pollInterval: 1500 },
      };
      server.handlers.set("tools/call", () => ({ result: taskResult }));

      const rawDispatch = getRawDispatch();
      const res = await rawDispatch(
        { method: "tools/call", params: { name: "slow", arguments: {} } },
        { context: { requestTimeoutMs: 1000 } },
      );

      expect(res).toEqual({ kind: "result", result: taskResult });
      const sent = server.received.find((m) => m.method === "tools/call")!;
      expect(sent.jsonrpc).toBe("2.0");
      expect(sent.params).toEqual({ name: "slow", arguments: {} });
    });

    it("passes resultType: complete through untouched", async () => {
      const complete = { resultType: "complete", content: [{ type: "text", text: "done" }] };
      server.handlers.set("tools/call", () => ({ result: complete }));

      const res = await getRawDispatch()({ method: "tools/call", params: { name: "fast" } });
      expect(res).toEqual({ kind: "result", result: complete });
    });

    it("maps a JSON-RPC error response to { kind: 'error' } with code, message and data", async () => {
      server.handlers.set("tasks/get", () => ({
        error: { code: -32602, message: "Unknown task", data: { taskId: "nope" } },
      }));

      const res = await getRawDispatch()({ method: "tasks/get", params: { taskId: "nope" } });
      expect(res).toEqual({
        kind: "error",
        error: { code: -32602, message: "Unknown task", data: { taskId: "nope" } },
      });
    });

    it("allocates ids from the SDK counter so raw and SDK requests never collide", async () => {
      server.handlers.set("tools/call", () => ({ result: { content: [] } }));
      const rawDispatch = getRawDispatch();

      await rawDispatch({ method: "tools/call", params: { name: "a" } });
      await server.client.ping();
      await rawDispatch({ method: "tools/call", params: { name: "b" } });
      await server.client.ping();

      const ids = server.received.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("rejects on timeout, aborts transport requestSignal, and unregisters its response handler", async () => {
      server.handlers.set("tools/call", () => "no-reply");
      const sendSpy = vi.spyOn(server.client.transport!, "send");
      const rawDispatch = getRawDispatch();

      await expect(
        rawDispatch({ method: "tools/call", params: { name: "hang" } }, { context: { requestTimeoutMs: 20 } }),
      ).rejects.toThrow(/timed out after 20ms for tools\/call/);

      const sent = server.received.find((m) => m.method === "tools/call")!;
      expect(responseHandlersOf(server.client).has(sent.id as number)).toBe(false);
      const sendOptions = sendSpy.mock.calls[0]?.[1];
      expect(sendOptions?.requestSignal?.aborted).toBe(true);
    });

    it("throws when the SDK client's internal _requestMessageId counter is missing", async () => {
      const rawDispatch = getRawDispatch();
      (server.client as unknown as { _requestMessageId?: unknown })._requestMessageId = undefined;

      await expect(
        rawDispatch({ method: "tools/call", params: { name: "a" } }),
      ).rejects.toThrow("MCP client request message ID counter is not available");
    });

    it("rejects immediately with the abort reason when the signal is already aborted", async () => {
      const controller = new AbortController();
      const reason = new Error("caller gave up");
      controller.abort(reason);

      await expect(
        getRawDispatch()({ method: "tools/call", params: {} }, { signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(server.received.some((m) => m.method === "tools/call")).toBe(false);
    });

    it("rejects and unregisters the handler when aborted mid-flight", async () => {
      server.handlers.set("tools/call", () => "no-reply");
      const controller = new AbortController();
      const pending = getRawDispatch()(
        { method: "tools/call", params: {} },
        { signal: controller.signal, context: { requestTimeoutMs: 5000 } },
      );
      // Let the request reach the server before aborting.
      await vi.waitFor(() => expect(server.received.some((m) => m.method === "tools/call")).toBe(true));

      const reason = new Error("stop");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);

      const sent = server.received.find((m) => m.method === "tools/call")!;
      expect(responseHandlersOf(server.client).has(sent.id as number)).toBe(false);
    });

    it("rejects malformed requests without touching the transport", async () => {
      const rawDispatch = getRawDispatch();
      await expect(rawDispatch({ params: {} } as never)).rejects.toThrow(TypeError);
      await expect(rawDispatch(null as never)).rejects.toThrow(TypeError);
      expect(server.received.filter((m) => m.method !== "initialize")).toHaveLength(0);
    });
  });
});

// 2. Session factory + server-task helpers (mocked collaborators)

function fakeClient(era: "modern" | "legacy") {
  return {
    getProtocolEra: vi.fn(() => era),
    getNegotiatedProtocolVersion: vi.fn(() => V2_VERSION),
    transport: {},
  } as unknown as Client;
}

interface FakeSession {
  capabilities: { inventory: string };
  listTasks: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
  task: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  controller: { snapshot: ReturnType<typeof vi.fn>; result: ReturnType<typeof vi.fn> };
}

function makeFakeSession(overrides: Partial<{ inventory: string }> = {}): FakeSession {
  const controller = { snapshot: vi.fn(), result: vi.fn() };
  return {
    capabilities: { inventory: overrides.inventory ?? "server-list" },
    listTasks: vi.fn(),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    task: vi.fn(() => controller),
    close: vi.fn().mockResolvedValue(undefined),
    controller,
  };
}

/** Wire withMcpAdminClient to invoke `fn` with the given client. */
function useAdminClient(client: Client): void {
  withMcpAdminClientMock.mockImplementation(async (opts: { fn: (ctx: unknown) => Promise<unknown> }) =>
    opts.fn({ client, server: { id: "srv-1" }, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS }),
  );
}

describe("createTaskSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTaskSessionFromClientMock.mockReturnValue({});
  });

  it("creates a plain session (no V2 options) for legacy servers", () => {
    const client = fakeClient("legacy");
    createTaskSession(client, CLIENT_INFO, CLIENT_CAPS, "ep-1");
    expect(createTaskSessionFromClientMock).toHaveBeenCalledWith(client, { endpointId: "ep-1" });
  });

  it("adds rawDispatch and v2RequestFraming for modern servers", () => {
    const client = fakeClient("modern");
    createTaskSession(client, CLIENT_INFO, CLIENT_CAPS, "ep-2");
    expect(createTaskSessionFromClientMock).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        endpointId: "ep-2",
        rawDispatch: expect.any(Function),
        v2RequestFraming: expect.objectContaining({ protocolVersion: V2_VERSION }),
      }),
    );
  });
});

describe("listServerTasks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the server page and closes the session", async () => {
    const session = makeFakeSession();
    session.listTasks.mockResolvedValue({ tasks: [{ taskId: "t1" }], nextCursor: "c2" });
    createTaskSessionFromClientMock.mockReturnValue(session);
    useAdminClient(fakeClient("legacy"));

    await expect(listServerTasks("srv-1", "c1")).resolves.toEqual({
      tasks: [{ taskId: "t1" }],
      nextCursor: "c2",
    });
    expect(session.listTasks).toHaveBeenCalledWith("c1");
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(withMcpAdminClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", errorPrefix: "Failed to list tasks" }),
    );
  });

  it("returns an empty page without calling tasks/list when the server has no inventory", async () => {
    const session = makeFakeSession({ inventory: "none" });
    createTaskSessionFromClientMock.mockReturnValue(session);
    useAdminClient(fakeClient("legacy"));

    await expect(listServerTasks("srv-1")).resolves.toEqual({ tasks: [] });
    expect(session.listTasks).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("still closes the session when listTasks throws", async () => {
    const session = makeFakeSession();
    session.listTasks.mockRejectedValue(new Error("boom"));
    createTaskSessionFromClientMock.mockReturnValue(session);
    useAdminClient(fakeClient("legacy"));

    await expect(listServerTasks("srv-1")).rejects.toThrow("boom");
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});

describe("getServerTask", () => {
  let session: FakeSession;

  beforeEach(() => {
    vi.clearAllMocks();
    session = makeFakeSession();
    createTaskSessionFromClientMock.mockReturnValue(session);
    useAdminClient(fakeClient("modern"));
  });

  it("returns a non-terminal snapshot as-is without fetching the result", async () => {
    const snapshot = { taskId: "t1", status: "working", raw: { taskId: "t1", status: "working" } };
    session.controller.snapshot.mockResolvedValue(snapshot);

    await expect(getServerTask("srv-1", "t1")).resolves.toBe(snapshot);
    expect(session.task).toHaveBeenCalledWith("t1");
    expect(session.controller.result).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("uses an inline result on a completed snapshot and normalizes it", async () => {
    const inline = { content: [{ type: "text", text: "{\"a\":1}" }], structuredContent: { a: 1 } };
    session.controller.snapshot.mockResolvedValue({
      taskId: "t1",
      status: "completed",
      raw: { taskId: "t1", status: "completed", result: inline },
    });

    const res = await getServerTask("srv-1", "t1");
    expect(session.controller.result).not.toHaveBeenCalled();
    expect(res.result).toEqual(expect.objectContaining({ structuredContent: { a: 1 } }));
    // Redundant JSON text is collapsed by normalizeMcpToolResult.
    expect((res.result as { content: Array<{ text: unknown }> }).content[0].text).not.toBe("{\"a\":1}");
    expect((res.raw as Record<string, unknown>).result).toEqual(res.result);
  });

  it("falls back to controller.result() when a completed snapshot has no inline result", async () => {
    const fetched = { content: [{ type: "text", text: "late" }] };
    session.controller.snapshot.mockResolvedValue({
      taskId: "t1",
      status: "completed",
      raw: { taskId: "t1", status: "completed" },
    });
    session.controller.result.mockResolvedValue({ status: "completed", result: fetched });

    const res = await getServerTask("srv-1", "t1");
    expect(session.controller.result).toHaveBeenCalledTimes(1);
    expect(res.result).toEqual(expect.objectContaining({ content: [expect.objectContaining({ text: "late" })] }));
  });

  it("returns the bare snapshot when the result fallback throws", async () => {
    const snapshot = { taskId: "t1", status: "completed", raw: { taskId: "t1", status: "completed" } };
    session.controller.snapshot.mockResolvedValue(snapshot);
    session.controller.result.mockRejectedValue(new Error("expired"));

    await expect(getServerTask("srv-1", "t1")).resolves.toBe(snapshot);
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});

describe("cancelServerTask", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancels by task id and closes the session even on failure", async () => {
    const session = makeFakeSession();
    createTaskSessionFromClientMock.mockReturnValue(session);
    useAdminClient(fakeClient("legacy"));

    await cancelServerTask("srv-1", "t9");
    expect(session.cancelTask).toHaveBeenCalledWith("t9");
    expect(session.close).toHaveBeenCalledTimes(1);

    session.cancelTask.mockRejectedValueOnce(new Error("already terminal"));
    await expect(cancelServerTask("srv-1", "t9")).rejects.toThrow("already terminal");
    expect(session.close).toHaveBeenCalledTimes(2);
  });
});
