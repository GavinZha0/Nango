import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

const { listIntegrationCredentialsForSelectorMock } = vi.hoisted(() => ({
  listIntegrationCredentialsForSelectorMock: vi.fn(),
}));

vi.mock("@/lib/credentials/lookup", () => ({
  listIntegrationCredentialsForSelector: listIntegrationCredentialsForSelectorMock,
}));

import { createMockRequest } from "tests/unit/helpers";
import { GET as getCredentials } from "@/app/api/credentials/route";

describe("GET /api/credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for unauthenticated requests", async () => {
    getSessionMock.mockResolvedValue(null);

    const req = createMockRequest("/api/credentials?purpose=suite-variable");
    const res = await getCredentials(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(401);
  });

  it("returns 403 for plain user role (requires editor+)", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", role: "user", email: "user@test.com" },
      session: { id: "sess-1" },
    });

    const req = createMockRequest("/api/credentials?purpose=suite-variable");
    const res = await getCredentials(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(403);
  });

  it("returns integration credential selector items when purpose=suite-variable for editor", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "editor-1", role: "editor", email: "editor@test.com" },
      session: { id: "sess-1" },
    });

    const mockItems = [
      {
        id: "cred-1",
        name: "Test Login Credential",
        provider: "testing",
        type: "basic_auth",
        fields: ["username", "password"],
      },
    ];
    listIntegrationCredentialsForSelectorMock.mockResolvedValueOnce(mockItems);

    const req = createMockRequest("/api/credentials?purpose=suite-variable");
    const res = await getCredentials(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(mockItems);
    expect(listIntegrationCredentialsForSelectorMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty array if purpose is omitted or different", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "editor-1", role: "editor", email: "editor@test.com" },
      session: { id: "sess-1" },
    });

    const req = createMockRequest("/api/credentials");
    const res = await getCredentials(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
    expect(listIntegrationCredentialsForSelectorMock).not.toHaveBeenCalled();
  });
});
