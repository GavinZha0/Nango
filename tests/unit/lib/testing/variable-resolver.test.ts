import { describe, it, expect, vi, beforeEach } from "vitest";

const getCredentialFieldsByIdMock = vi.fn();

vi.mock("@/lib/credentials/lookup", () => ({
  getCredentialFieldsById: getCredentialFieldsByIdMock,
}));

const { resolveSuiteVariables } = await import(
  "@/lib/testing/variable-resolver.server"
);

describe("resolveSuiteVariables", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles empty or missing variables gracefully", async () => {
    const res = await resolveSuiteVariables({});
    expect(res.error).toBeNull();
    expect(res.resolved).toEqual({});
    expect(res.literalVariables).toEqual({});
    expect(res.sensitiveValues.size).toBe(0);
  });

  it("unpacks legacy flat records as literals (backwards compatibility)", async () => {
    const raw = {
      baseUrl: "https://example.com",
      retryCount: 3,
      isActive: true,
    };

    const res = await resolveSuiteVariables(raw);
    expect(res.error).toBeNull();
    expect(res.resolved).toEqual(raw);
    expect(res.literalVariables).toEqual(raw);
    expect(res.sensitiveValues.size).toBe(0);
  });

  it("unpacks structured literal variables into both resolved and literalVariables", async () => {
    const raw = {
      baseUrl: { type: "literal", value: "https://staging.test.com" },
      timeout: { type: "literal", value: 5000 },
    };

    const res = await resolveSuiteVariables(raw);
    expect(res.error).toBeNull();
    expect(res.resolved).toEqual({
      baseUrl: "https://staging.test.com",
      timeout: 5000,
    });
    expect(res.literalVariables).toEqual({
      baseUrl: "https://staging.test.com",
      timeout: 5000,
    });
    expect(res.sensitiveValues.size).toBe(0);
  });

  it("blocks credential variables when allowCredentials is false (Verification & Evaluation defense)", async () => {
    const raw = {
      dbPass: {
        type: "credential",
        credentialId: "cred-1",
        field: "password",
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: false });
    expect(res.error).toEqual({
      source: "config",
      message: expect.stringContaining("Credential variables are not permitted"),
    });
    expect(getCredentialFieldsByIdMock).not.toHaveBeenCalled();
  });

  it("blocks credential variables if credential is not found", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce(null);

    const raw = {
      adminPass: {
        type: "credential",
        credentialId: "cred-missing",
        field: "password",
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: true });
    expect(res.error).toEqual({
      source: "config",
      message: expect.stringContaining("Credential 'cred-missing' not found"),
    });
  });

  it("blocks credential variables if serviceType is not integration (e.g. llm or agent)", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      id: "cred-llm",
      type: "api_key",
      serviceType: "llm",
      fields: { key: "sk-openai-key-here" },
    });

    const raw = {
      llmKey: {
        type: "credential",
        credentialId: "cred-llm",
        field: "key",
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: true });
    expect(res.error).toEqual({
      source: "config",
      message: expect.stringContaining("not registered under 'integration' service with 'testing' provider"),
    });
  });

  it("blocks credential variables if serviceType is integration but provider is not testing (e.g. ssh or mcp)", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      id: "cred-ssh",
      type: "ssh_key",
      serviceType: "integration",
      provider: "ssh",
      fields: { privateKey: "ssh-rsa ..." },
    });

    const raw = {
      sshKey: {
        type: "credential",
        credentialId: "cred-ssh",
        field: "privateKey",
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: true });
    expect(res.error).toEqual({
      source: "config",
      message: expect.stringContaining("not registered under 'integration' service with 'testing' provider"),
    });
  });

  it("successfully resolves integration credentials and collects only secret fields into sensitiveValues", async () => {
    getCredentialFieldsByIdMock.mockResolvedValue({
      id: "cred-integration-1",
      type: "basic_auth",
      serviceType: "integration",
      provider: "testing",
      fields: {
        username: "admin_user",
        password: "super_secret_password_123",
      },
    });

    const raw = {
      BASE_URL: { type: "literal", value: "https://my-app.test" },
      ADMIN_USER: { type: "literal", value: "admin_user" },
      ADMIN_PASS: {
        type: "credential",
        credentialId: "cred-integration-1",
        field: "password",
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: true });
    expect(res.error).toBeNull();

    // 1. resolved has all variables
    expect(res.resolved).toEqual({
      BASE_URL: "https://my-app.test",
      ADMIN_USER: "admin_user",
      ADMIN_PASS: "super_secret_password_123",
    });

    // 2. literalVariables contains ONLY plain variables (no credentials)
    expect(res.literalVariables).toEqual({
      BASE_URL: "https://my-app.test",
      ADMIN_USER: "admin_user",
    });

    // 3. sensitiveValues contains ONLY credentials (super_secret_password_123), plain literal is excluded
    expect(res.sensitiveValues.has("super_secret_password_123")).toBe(true);
    expect(res.sensitiveValues.has("admin_user")).toBe(false);
  });

  it("treats all credential variables with sufficient length as sensitive values", async () => {
    getCredentialFieldsByIdMock.mockResolvedValue({
      id: "cred-integration-2",
      type: "api_key",
      serviceType: "integration",
      provider: "testing",
      fields: {
        token: "custom_token_val",
        apiKey: "api_key_secret_val",
      },
    });

    const raw = {
      TOKEN: {
        type: "credential",
        credentialId: "cred-integration-2",
        field: "token",
      },
      API_KEY: {
        type: "credential",
        credentialId: "cred-integration-2",
        field: "apiKey",
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: true });
    expect(res.error).toBeNull();
    expect(res.sensitiveValues.has("custom_token_val")).toBe(true);
    expect(res.sensitiveValues.has("api_key_secret_val")).toBe(true);
  });

  it("does not add strings under MIN_SENSITIVE_LENGTH (4) to sensitiveValues", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      id: "cred-integration-3",
      type: "basic_auth",
      serviceType: "integration",
      provider: "testing",
      fields: {
        password: "123",
      },
    });

    const raw = {
      SHORT_PASS: {
        type: "credential",
        credentialId: "cred-integration-3",
        field: "password",
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: true });
    expect(res.error).toBeNull();
    expect(res.sensitiveValues.size).toBe(0);
  });

  it("collects number-type sensitive fields (e.g. numeric PIN) into sensitiveValues as string", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      id: "cred-integration-pin",
      type: "basic_auth",
      serviceType: "integration",
      provider: "testing",
      fields: {
        pin: 654321,
      },
    });

    const raw = {
      APP_PIN: {
        type: "credential",
        credentialId: "cred-integration-pin",
        field: "pin",
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: true });
    expect(res.error).toBeNull();
    expect(res.resolved.APP_PIN).toBe(654321);
    expect(res.sensitiveValues.has("654321")).toBe(true);
  });

  it("returns structured config error when specified field is missing from credential", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      id: "cred-integration-1",
      type: "api_key",
      serviceType: "integration",
      provider: "testing",
      fields: {
        username: "admin",
      },
    });

    const raw = {
      AUTH_TOKEN: {
        type: "credential",
        credentialId: "cred-integration-1",
        field: "token", // Missing!
      },
    };

    const res = await resolveSuiteVariables(raw, { allowCredentials: true });
    expect(res.error).not.toBeNull();
    expect(res.error?.source).toBe("config");
    expect(res.error?.message).toContain("Field 'token' not found in credential 'cred-integration-1'");
  });
});
