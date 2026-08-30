import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getGuardrailConfigCacheMock } = vi.hoisted(() => ({
  getGuardrailConfigCacheMock: vi.fn(),
}));

vi.mock("@/lib/agent-pipeline/guardrail-service", () => ({
  getGuardrailConfigCache: getGuardrailConfigCacheMock,
}));

import {
  DEFAULT_REDACTION_RULES,
  getActiveRedactionRules,
  redactSensitiveText,
  SlidingWindowRedactor,
  SseStreamRedactor,
  type RedactionRule,
} from "@/lib/agent-pipeline/output-safety";

describe("Agent Pipeline — Output Safety & Stream Redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGuardrailConfigCacheMock.mockReturnValue({
      safetyPolicies: [],
    });
  });

  describe("Default Redaction Rules & redactSensitiveText", () => {
    it("redacts Chinese mobile numbers and ID cards with masking", () => {
      const input = "Contact 13812345678 or ID 110101199001011234 for details";
      const output = redactSensitiveText(input, DEFAULT_REDACTION_RULES);

      expect(output).toContain("138****5678");
      expect(output).toContain("110101********1234");
    });

    it("redacts US phone numbers and credit card numbers", () => {
      const input = "Call (555) 123-4567 or charge 4111-2222-3333-4444";
      const output = redactSensitiveText(input, DEFAULT_REDACTION_RULES);

      expect(output).toContain("(555) ***-4567");
      expect(output).toContain("4111-****-****-4444");
    });

    it("redacts API keys, AWS access keys and Bearer tokens", () => {
      const input =
        "Keys: sk-abcdefghijklmnopqrstuvwxyz123456, AKIA1234567890ABCDEF, Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123";
      const output = redactSensitiveText(input, DEFAULT_REDACTION_RULES);

      expect(output).toContain("[REDACTED_API_KEY]");
      expect(output).toContain("[REDACTED_AWS_KEY]");
      expect(output).toContain("Bearer [REDACTED_TOKEN]");
      expect(output).not.toContain("sk-abc");
    });

    it("calls onRedact callback with detected snippet and rule name", () => {
      const detected: Array<{ name: string; snippet: string }> = [];
      const onRedact = (rule: RedactionRule, snippet: string) => {
        detected.push({ name: rule.name, snippet });
      };

      redactSensitiveText(
        "Found email testuser@example.com and sk-abcdefghijklmnopqrstuvwxyz123456",
        DEFAULT_REDACTION_RULES,
        onRedact,
      );

      expect(detected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "email" }),
          expect.objectContaining({ name: "openai_api_key" }),
        ]),
      );
    });
  });

  describe("Dynamic DB Rule Loading (getActiveRedactionRules)", () => {
    it("falls back to DEFAULT_REDACTION_RULES when no output rules in DB", () => {
      getGuardrailConfigCacheMock.mockReturnValue({
        safetyPolicies: [
          {
            name: "input_rule",
            scope: "input",
            enabled: true,
            policyType: "regex",
            policyConfig: {},
          },
        ],
      });

      const rules = getActiveRedactionRules();
      expect(rules).toEqual(DEFAULT_REDACTION_RULES);
    });

    it("loads custom output regex rules from guardrail DB cache", () => {
      getGuardrailConfigCacheMock.mockReturnValue({
        safetyPolicies: [
          {
            name: "custom_token_redact",
            scope: "output",
            enabled: true,
            policyType: "regex",
            policyConfig: {
              pattern: "SECRET_[A-Z0-9]{8}",
              replacement: "[CONFIDENTIAL_TOKEN]",
            },
          },
        ],
      });

      const rules = getActiveRedactionRules();
      expect(rules.length).toBe(1);
      expect(rules[0].name).toBe("custom_token_redact");

      const result = redactSensitiveText("Token is SECRET_ABC12345", rules);
      expect(result).toBe("Token is [CONFIDENTIAL_TOKEN]");
    });
  });

  describe("SlidingWindowRedactor (Streaming Pass-Through)", () => {
    it("buffers small chunks and flushes redacted text across chunk boundaries", () => {
      const redactor = new SlidingWindowRedactor(60, DEFAULT_REDACTION_RULES);

      // Push secret in multiple split chunks across boundaries
      const part1 = "Your secret API key is: sk-abc";
      const part2 = "defghijklmnopqrstuvwxyz123456 for authorization.";
      const part3 = " Please keep it safe!";

      let streamOutput = "";
      streamOutput += redactor.push(part1);
      streamOutput += redactor.push(part2);
      streamOutput += redactor.push(part3);
      streamOutput += redactor.flush();

      expect(streamOutput).toContain("[REDACTED_API_KEY]");
      expect(streamOutput).not.toContain("sk-abcdef");
    });
  });

  describe("SseStreamRedactor (CopilotKit Protocol Aware)", () => {
    it("processes TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END and [DONE] events with masking", () => {
      const redactor = new SseStreamRedactor(DEFAULT_REDACTION_RULES);

      const chunk1 =
        'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Here is your phone number: 1391234"}\n\n' +
        'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"5678 and key sk-abcdefghijklmnopqrstuvwxyz123456"}\n\n';

      const chunk2 = 'data: {"type":"TEXT_MESSAGE_END"}\n\n' + "data: [DONE]\n\n";

      let processed = redactor.processChunk(chunk1);
      processed += redactor.processChunk(chunk2);
      processed += redactor.flush();

      expect(processed).toContain("139****5678");
      expect(processed).toContain("[REDACTED_API_KEY]");
      expect(processed).not.toContain("13912345678");
    });

    it("processes REASONING_MESSAGE_CONTENT and REASONING_MESSAGE_END streams", () => {
      const redactor = new SseStreamRedactor(DEFAULT_REDACTION_RULES);

      const chunk =
        'data: {"type":"REASONING_MESSAGE_CONTENT","messageId":"reason-1","delta":"Thinking: user card is 4111-2222-3333-4444"}\n\n' +
        'data: {"type":"REASONING_MESSAGE_END"}\n\n';

      let processed = redactor.processChunk(chunk);
      processed += redactor.flush();

      expect(processed).toContain("4111-****-****-4444");
      expect(processed).not.toContain("4111-2222-3333-4444");
    });

    it("passes through unknown SSE events and invalid JSON safely", () => {
      const redactor = new SseStreamRedactor(DEFAULT_REDACTION_RULES);

      const rawChunk =
        ": ping heartbeat\n" +
        'data: {"type":"CUSTOM_PING_EVENT","timestamp":123456}\n\n' +
        "data: {invalid-json-payload\n\n";

      const processed = redactor.processChunk(rawChunk);
      expect(processed).toContain("ping heartbeat");
      expect(processed).toContain("CUSTOM_PING_EVENT");
      expect(processed).toContain("{invalid-json-payload");
    });
  });
});
