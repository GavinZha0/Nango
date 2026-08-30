import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

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

const { clientConnectMock, clientCloseMock } = vi.hoisted(() => ({
  clientConnectMock: vi.fn(),
  clientCloseMock: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: function MockClient() {
      return {
        connect: clientConnectMock,
        close: clientCloseMock,
      };
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

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
        fn: async ({ client: _client, server }) => {
          expect(server.id).toBe("server-1");
          return { tools: ["tool_a", "tool_b"] };
        },
      });

      expect(result).toEqual({ tools: ["tool_a", "tool_b"] });
      expect(clientConnectMock).toHaveBeenCalledTimes(1);
      expect(clientCloseMock).toHaveBeenCalledTimes(1);
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
