import { describe, it, expect, vi, beforeEach } from "vitest";

const { getCredentialFieldsByIdMock, getOAuthAccessTokenMock } = vi.hoisted(() => ({
  getCredentialFieldsByIdMock: vi.fn(),
  getOAuthAccessTokenMock: vi.fn(),
}));

vi.mock("@/lib/credentials/lookup", () => ({
  getCredentialFieldsById: getCredentialFieldsByIdMock,
}));

vi.mock("@/lib/credentials/oauth-token-manager", () => ({
  getOAuthAccessToken: getOAuthAccessTokenMock,
}));

const { dbMock } = vi.hoisted(() => {
  const queryMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
  };
  return {
    dbMock: {
      select: vi.fn().mockReturnValue(queryMock),
      _queryMock: queryMock,
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

const { clientConnectMock, clientCloseMock, clientCtorMock } = vi.hoisted(() => ({
  clientConnectMock: vi.fn(),
  clientCloseMock: vi.fn(),
  clientCtorMock: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client", () => {
  return {
    Client: function MockClient(info: unknown, opts: unknown) {
      clientCtorMock(info, opts);
      return {
        connect: clientConnectMock,
        close: clientCloseMock,
      };
    },
    SSEClientTransport: vi.fn(),
    StreamableHTTPClientTransport: vi.fn(),
  };
});

import { buildMcpHeaders, withMcpAdminClient } from "@/lib/mcp/admin-client.server";
import { ApiError } from "@/lib/http/route-handlers";

describe("MCP Admin Client & Header Resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildMcpHeaders", () => {
    it("returns static headers when server has no credential attached", async () => {
      const headers = await buildMcpHeaders({
        headers: { "X-Custom-Header": "custom-val" },
        credentialId: null,
        credentialHeader: "Authorization",
      });

      expect(headers).toEqual({ "X-Custom-Header": "custom-val" });
    });

    it("resolves api_key / token credential and formats as Bearer token", async () => {
      getCredentialFieldsByIdMock.mockResolvedValueOnce({
        type: "api_key",
        fields: { token: "mcp-api-key-12345" },
      });

      const headers = await buildMcpHeaders({
        headers: { "X-Custom": "val" },
        credentialId: "cred-uuid-1",
        credentialHeader: "Authorization",
      });

      expect(headers).toEqual({
        "X-Custom": "val",
        Authorization: "Bearer mcp-api-key-12345",
      });
    });

    it("handles oauth_client credentials by resolving access token", async () => {
      getCredentialFieldsByIdMock.mockResolvedValueOnce({
        type: "oauth_client",
        fields: {},
      });
      getOAuthAccessTokenMock.mockResolvedValueOnce("oauth-live-access-token-999");

      const headers = await buildMcpHeaders({
        headers: {},
        credentialId: "cred-oauth-uuid",
        credentialHeader: "X-Auth-Token",
      });

      expect(headers).toEqual({
        "X-Auth-Token": "oauth-live-access-token-999",
      });
    });

    it("survives OAuth token resolution failure gracefully without crashing", async () => {
      getCredentialFieldsByIdMock.mockResolvedValueOnce({
        type: "oauth_client",
        fields: {},
      });
      getOAuthAccessTokenMock.mockRejectedValueOnce(new Error("Refresh token expired"));

      const headers = await buildMcpHeaders({
        headers: { "X-Fallback": "present" },
        credentialId: "cred-oauth-failed",
        credentialHeader: "Authorization",
      });

      expect(headers).toEqual({ "X-Fallback": "present" });
    });
  });

  describe("withMcpAdminClient Execution & Error Mapping", () => {
    it("throws 404 NOT_FOUND when MCP server row is missing in DB", async () => {
      dbMock._queryMock.where.mockResolvedValueOnce([]);

      await expect(
        withMcpAdminClient({
          serverId: "non-existent-server",
          clientName: "admin-test",
          errorPrefix: "Failed to discover tools",
          fn: async () => {},
        }),
      ).rejects.toThrow(ApiError);
    });

    it("connects client, executes fn, and always closes client in finally", async () => {
      const mockServer = {
        id: "server-1",
        url: "http://localhost:8000/sse",
        type: "sse",
        headers: {},
      };
      dbMock._queryMock.where.mockResolvedValueOnce([mockServer]);

      const result = await withMcpAdminClient({
        serverId: "server-1",
        clientName: "admin-test",
        errorPrefix: "Discovery failed",
        fn: async ({ client: _client, server, clientInfo, clientCapabilities }) => {
          expect(server.id).toBe("server-1");
          expect(clientInfo).toEqual({ name: "admin-test", version: "1.0.0" });
          expect(clientCapabilities).toEqual({
            extensions: {
              "io.modelcontextprotocol/tasks": {},
            },
          });
          return { tools: ["tool_a", "tool_b"] };
        },
      });

      expect(result).toEqual({ tools: ["tool_a", "tool_b"] });
      expect(clientCtorMock).toHaveBeenCalledWith(
        { name: "admin-test", version: "1.0.0" },
        {
          versionNegotiation: { mode: "auto" },
          capabilities: {
            extensions: {
              "io.modelcontextprotocol/tasks": {},
            },
          },
        },
      );
      const [, ctorOptions] = clientCtorMock.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(ctorOptions.jsonSchemaValidator).toBeUndefined();
      expect(clientConnectMock).toHaveBeenCalledTimes(1);
      expect(clientCloseMock).toHaveBeenCalledTimes(1);
    });

    it("enforces admin callerRole and uses mcp.stdio_discovery_timeout (120s) for stdio MCP servers", async () => {
      const prevAllow = process.env.NANGO_ALLOW_STDIO_MCP;
      process.env.NANGO_ALLOW_STDIO_MCP = "true";
      try {
        const stdioServer = {
          id: "server-stdio",
          url: "",
          type: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
          env: null,
          cwd: null,
          credentialId: null,
          credentialEnvName: null,
        };

        // 1. Non-admin editor is rejected with 403 FORBIDDEN before spawning
        dbMock._queryMock.where.mockResolvedValueOnce([stdioServer]);
        await expect(
          withMcpAdminClient({
            serverId: "server-stdio",
            clientName: "admin-test",
            errorPrefix: "Discovery failed",
            callerRole: "editor",
            fn: async () => {},
          }),
        ).rejects.toThrow(
          /Only admins can discover or invoke tools on stdio MCP servers/,
        );
        expect(clientConnectMock).not.toHaveBeenCalled();

        // 2. Admin connects with mcp.stdio_discovery_timeout (120_000ms)
        dbMock._queryMock.where.mockResolvedValueOnce([stdioServer]);
        let observedTimeoutMs = 0;
        await withMcpAdminClient({
          serverId: "server-stdio",
          clientName: "admin-test",
          errorPrefix: "Discovery failed",
          callerRole: "admin",
          fn: async ({ discoveryTimeoutMs }) => {
            observedTimeoutMs = discoveryTimeoutMs;
          },
        });
        expect(observedTimeoutMs).toBe(120_000);
        expect(clientConnectMock).toHaveBeenCalledWith(
          expect.anything(),
          { timeout: 120_000 },
        );
      } finally {
        if (prevAllow === undefined) {
          delete process.env.NANGO_ALLOW_STDIO_MCP;
        } else {
          process.env.NANGO_ALLOW_STDIO_MCP = prevAllow;
        }
      }
    });

    it("wraps transport connection errors as 502 BAD_GATEWAY", async () => {
      const mockServer = {
        id: "server-2",
        url: "http://localhost:8000/sse",
        type: "sse",
        headers: {},
      };
      dbMock._queryMock.where.mockResolvedValueOnce([mockServer]);
      clientConnectMock.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:8000"));

      await expect(
        withMcpAdminClient({
          serverId: "server-2",
          clientName: "admin-test",
          errorPrefix: "Tool discovery failed",
          fn: async () => {},
        }),
      ).rejects.toThrow(/Tool discovery failed: ECONNREFUSED/i);

      expect(clientCloseMock).toHaveBeenCalledTimes(1);
    });
  });
});
