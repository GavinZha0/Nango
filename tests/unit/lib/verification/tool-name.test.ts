import { describe, expect, it } from "vitest";
import {
  resolveEffectiveToolName,
  type ToolPrefixRule,
} from "@/lib/verification/tool-name";

describe("resolveEffectiveToolName", () => {
  describe("mode: none or nullish rules", () => {
    it("returns toolName unchanged when rule is null", () => {
      expect(resolveEffectiveToolName("query_users", null)).toBe("query_users");
    });

    it("returns toolName unchanged when rule is undefined", () => {
      expect(resolveEffectiveToolName("query_users", undefined)).toBe(
        "query_users",
      );
    });

    it("returns toolName unchanged when mode is 'none'", () => {
      const rule: ToolPrefixRule = { mode: "none", prefix: "gw_" };
      expect(resolveEffectiveToolName("query_users", rule)).toBe("query_users");
    });

    it("returns toolName unchanged when prefix is empty or whitespace", () => {
      expect(
        resolveEffectiveToolName("query_users", {
          mode: "add",
          prefix: "",
        }),
      ).toBe("query_users");
      expect(
        resolveEffectiveToolName("query_users", {
          mode: "add",
          prefix: "   ",
        }),
      ).toBe("query_users");
      expect(
        resolveEffectiveToolName("query_users", {
          mode: "remove",
          prefix: "",
        }),
      ).toBe("query_users");
    });

    it("returns empty string when toolName is empty", () => {
      expect(
        resolveEffectiveToolName("", { mode: "add", prefix: "gw_" }),
      ).toBe("");
    });
  });

  describe("mode: add", () => {
    it("prepends prefix when toolName does not have it", () => {
      const rule: ToolPrefixRule = { mode: "add", prefix: "gw_" };
      expect(resolveEffectiveToolName("query_users", rule)).toBe(
        "gw_query_users",
      );
    });

    it("is idempotent: does not duplicate prefix if already present", () => {
      const rule: ToolPrefixRule = { mode: "add", prefix: "gw_" };
      expect(resolveEffectiveToolName("gw_query_users", rule)).toBe(
        "gw_query_users",
      );
    });

    it("is case-insensitive when checking for existing prefix", () => {
      const rule: ToolPrefixRule = { mode: "add", prefix: "gw_" };
      expect(resolveEffectiveToolName("GW_query_users", rule)).toBe(
        "GW_query_users",
      );
      expect(resolveEffectiveToolName("Gw_query_users", rule)).toBe(
        "Gw_query_users",
      );
    });

    it("trims whitespace from the configured prefix", () => {
      const rule: ToolPrefixRule = { mode: "add", prefix: "  crm_  " };
      expect(resolveEffectiveToolName("get_lead", rule)).toBe("crm_get_lead");
    });
  });

  describe("mode: remove", () => {
    it("strips prefix when toolName starts with it", () => {
      const rule: ToolPrefixRule = { mode: "remove", prefix: "gw_" };
      expect(resolveEffectiveToolName("gw_query_users", rule)).toBe(
        "query_users",
      );
    });

    it("is case-insensitive when stripping prefix", () => {
      const rule: ToolPrefixRule = { mode: "remove", prefix: "gw_" };
      expect(resolveEffectiveToolName("GW_query_users", rule)).toBe(
        "query_users",
      );
      expect(resolveEffectiveToolName("Gw_query_users", rule)).toBe(
        "query_users",
      );
    });

    it("returns toolName unchanged if prefix does not match", () => {
      const rule: ToolPrefixRule = { mode: "remove", prefix: "gw_" };
      expect(resolveEffectiveToolName("other_query_users", rule)).toBe(
        "other_query_users",
      );
      expect(resolveEffectiveToolName("query_users", rule)).toBe(
        "query_users",
      );
    });

    it("handles toolName matching prefix exactly", () => {
      const rule: ToolPrefixRule = { mode: "remove", prefix: "gw_" };
      expect(resolveEffectiveToolName("gw_", rule)).toBe("");
    });

    it("trims whitespace from the configured prefix before removing", () => {
      const rule: ToolPrefixRule = { mode: "remove", prefix: "  api_  " };
      expect(resolveEffectiveToolName("api_endpoint", rule)).toBe("endpoint");
    });
  });
});
