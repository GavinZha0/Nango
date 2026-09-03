import { describe, it, expect } from "vitest";
import {
  getAssertionSchemaInputSchema,
  buildGetAssertionSchemaTool,
} from "@/lib/testing/tools/get-assertion-schema";
import type { GetAssertionSchemaResult } from "@/lib/testing/types";

describe("get_assertion_schema tool", () => {
  describe("Schema Validation", () => {
    it("accepts valid category without assertionType", () => {
      const parsed = getAssertionSchemaInputSchema.safeParse({
        category: "verification",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts valid category with null assertionType", () => {
      const parsed = getAssertionSchemaInputSchema.safeParse({
        category: "evaluation",
        assertionType: null,
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts valid category with valid assertionType", () => {
      const parsed = getAssertionSchemaInputSchema.safeParse({
        category: "web-auto",
        assertionType: "js_expression",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects missing category", () => {
      const parsed = getAssertionSchemaInputSchema.safeParse({});
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid category", () => {
      const parsed = getAssertionSchemaInputSchema.safeParse({
        category: "invalid_category",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects unknown assertionType", () => {
      const parsed = getAssertionSchemaInputSchema.safeParse({
        category: "verification",
        assertionType: "unsupported_type",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("Execution & Output", () => {
    const tool = buildGetAssertionSchemaTool({
      userId: "test-user-id",
    });

    it("returns all supported schemas for verification when assertionType is omitted", async () => {
      const res = (await tool.execute!({
        category: "verification",
      })) as GetAssertionSchemaResult;

      expect(res.category).toBe("verification");
      expect(res.types).toEqual(["jsonpath", "json_schema", "js_expression"]);
      expect(res.schemas.length).toBe(3);

      const jsonpathItem = res.schemas.find((s) => s.type === "jsonpath");
      expect(jsonpathItem).toBeDefined();
      expect(jsonpathItem?.jsonSchema).toBeDefined();
      expect(jsonpathItem?.example).toMatchObject({
        type: "jsonpath",
        path: "$.status",
        operator: "==",
        expected: "success",
      });
    });

    it("returns all supported schemas for evaluation", async () => {
      const res = (await tool.execute!({
        category: "evaluation",
        assertionType: null,
      })) as GetAssertionSchemaResult;

      expect(res.category).toBe("evaluation");
      expect(res.types).toEqual(["jsonpath", "js_expression", "llm_judge", "metric", "tool_call"]);
      expect(res.schemas.length).toBe(5);

      const llmJudgeItem = res.schemas.find((s) => s.type === "llm_judge");
      expect(llmJudgeItem).toBeDefined();
      expect(llmJudgeItem?.example).toHaveProperty("expectation");

      const jsonpathItem = res.schemas.find((s) => s.type === "jsonpath");
      expect(jsonpathItem).toBeDefined();
    });

    it("returns all supported schemas for web-auto", async () => {
      const res = (await tool.execute!({
        category: "web-auto",
      })) as GetAssertionSchemaResult;

      expect(res.category).toBe("web-auto");
      expect(res.types).toEqual(["js_expression", "jsonpath", "llm_judge"]);
      expect(res.schemas.length).toBe(3);
    });

    it("returns filtered single schema when assertionType is specified", async () => {
      const res = (await tool.execute!({
        category: "verification",
        assertionType: "json_schema",
      })) as GetAssertionSchemaResult;

      expect(res.category).toBe("verification");
      expect(res.types).toEqual(["json_schema"]);
      expect(res.schemas.length).toBe(1);
      expect(res.schemas[0].type).toBe("json_schema");
      expect(res.schemas[0].jsonSchema).toBeDefined();
      expect(res.schemas[0].example).toMatchObject({
        type: "json_schema",
        schema: {
          type: "object",
        },
      });
    });

    it("returns single metric schema with comparison operators", async () => {
      const res = (await tool.execute!({
        category: "evaluation",
        assertionType: "metric",
      })) as GetAssertionSchemaResult;

      expect(res.types).toEqual(["metric"]);
      expect(res.schemas.length).toBe(1);
      expect(res.schemas[0].type).toBe("metric");
      expect(res.schemas[0].example).toMatchObject({
        type: "metric",
        metric: "duration_s",
        operator: "<=",
        threshold: 5.0,
      });
    });

    it("throws error if assertionType is not supported for the requested category", async () => {
      await expect(
        tool.execute!({
          category: "verification",
          assertionType: "llm_judge",
        }),
      ).rejects.toThrow(/not supported for category 'verification'/i);
    });
  });
});
