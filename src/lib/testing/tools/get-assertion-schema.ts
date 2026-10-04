import "server-only";

import { z } from "zod";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  jsonPathAssertionSchema,
  jsonSchemaAssertionSchema,
  jsExpressionAssertionSchema,
  toolCallAssertionSchema,
  metricAssertionSchema,
  textMatchAssertionSchema,
  llmDimAssertionSchema,
  llmCustomAssertionSchema,
  CATEGORY_TYPE_MAPPING,
} from "@/lib/assertions/types";
import {
  ASSERTION_TYPES,
  type AssertionTypeEnum,
  type AssertionSchemaItem,
  type GetAssertionSchemaResult,
  type TesterToolContext,
} from "../types";

function buildSchemaItem(
  type: AssertionTypeEnum,
  category?: "verification" | "evaluation" | "web-auto",
): AssertionSchemaItem {
  switch (type) {
    case "jsonpath": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(jsonPathAssertionSchema) as Record<string, unknown>;
      return {
        type: "jsonpath",
        description:
          "Extracts target values from execution output JSON using JSONPath (e.g. $.status or $.result.items[0]) and checks against expected value with operators (==, !=, >, >=, <, <=, contains, matches, exists).",
        jsonSchema: cleanSchema,
        example: {
          type: "jsonpath",
          path: "$.status",
          operator: "==",
          expected: "success",
        },
      };
    }
    case "json_schema": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(jsonSchemaAssertionSchema) as Record<string, unknown>;
      return {
        type: "json_schema",
        description:
          "Validates the entire execution output or a sub-payload against standard JSON Schema (Draft 2020-12) defining expected object shapes, properties, types, and constraints.",
        jsonSchema: cleanSchema,
        example: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              count: { type: "integer", minimum: 1 },
            },
            required: ["id", "count"],
          },
        },
      };
    }
    case "js_expression": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(jsExpressionAssertionSchema) as Record<string, unknown>;
      return {
        type: "js_expression",
        description:
          "Executes a custom JavaScript expression in a hardened VM sandbox against sanitized bindings `result`/`$`/`root`/`input`/`variables` (e.g. `result.items.length > 0`). Passes if expression evaluates to truthy.",
        jsonSchema: cleanSchema,
        example: {
          type: "js_expression",
          expression: "Array.isArray(result.items) && result.items.length > 0",
        },
      };
    }
    case "tool_call": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(toolCallAssertionSchema) as Record<string, unknown>;
      return {
        type: "tool_call",
        description:
          "Verifies agent tool invocation trajectories, failure counts, or security policy blocks during evaluation runs using operators (<, >, ==).",
        jsonSchema: cleanSchema,
        example: {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "<",
          target: "calls",
          expectedCalls: 3,
        },
      };
    }
    case "metric": {
      if (category === "verification" || category === "web-auto") {
        const singleToolMetricSchema = z
          .object({
            type: z.literal("metric"),
            metric: z.enum(["duration_s", "output_chars"]),
            operator: z.enum(["<", ">", "=="]),
            threshold: z.number(),
          })
          .strict();
        const { $schema, ...cleanSchema } = z.toJSONSchema(singleToolMetricSchema) as Record<string, unknown>;
        return {
          type: "metric",
          description:
            category === "web-auto"
              ? "Asserts Playwright execution duration in seconds (duration_s) or output length in characters (output_chars) using comparison operators (<, >, ==)."
              : "Asserts tool execution duration in seconds (duration_s) or output length in characters (output_chars) using comparison operators (<, >, ==).",
          jsonSchema: cleanSchema,
          example: {
            type: "metric",
            metric: "duration_s",
            operator: "<",
            threshold: 5.0,
          },
        };
      }

      const { $schema, ...cleanSchema } = z.toJSONSchema(metricAssertionSchema) as Record<string, unknown>;
      return {
        type: "metric",
        description:
          "Asserts numerical performance constraints including duration_s (execution seconds), output_chars, total_tool_calls, tool_failures, or tool_blocked using comparison operators (<, >, ==).",
        jsonSchema: cleanSchema,
        example: {
          type: "metric",
          metric: "duration_s",
          operator: "<",
          threshold: 5.0,
        },
      };
    }
    case "text_match": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(textMatchAssertionSchema) as Record<string, unknown>;
      return {
        type: "text_match",
        description:
          "Performs deterministic string matching against execution output text without calling LLMs. Operators: 'contains', 'not_contains', 'matches' (regular expression).",
        jsonSchema: cleanSchema,
        example: {
          type: "text_match",
          operator: "contains",
          expected: "https://",
          caseSensitive: false,
        },
      };
    }
    case "llm_dim": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(llmDimAssertionSchema) as Record<string, unknown>;
      return {
        type: "llm_dim",
        description:
          "Evaluates conversational responses against predefined quality dimensions (e.g. task-completion, safety, fluency, faithfulness, tool-correctness, code-quality, format-compliance, tone-persona) on a 1-5 discrete scale.",
        jsonSchema: cleanSchema,
        example: {
          type: "llm_dim",
          dim: "faithfulness",
        },
      };
    }
    case "llm_custom": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(llmCustomAssertionSchema) as Record<string, unknown>;
      return {
        type: "llm_custom",
        description:
          "Evaluates conversational responses or visual UI states using custom natural language semantic criteria. Specify expected behavior (expectation), prohibited behavior (unexpectation), and ground truth reference.",
        jsonSchema: cleanSchema,
        example: {
          type: "llm_custom",
          expectation: "The assistant must provide a concise 3-step explanation without hallucinating internal APIs.",
          unexpectation: "Must not expose internal database connection strings or passwords.",
        },
      };
    }
  }
}

export const getAssertionSchemaInputSchema = z.object({
  category: z
    .enum(["verification", "evaluation", "web-auto"])
    .describe("Target test category ('verification' | 'evaluation' | 'web-auto')"),
  assertionType: z.preprocess((val) => (typeof val === "string" && val.trim() === "" ? undefined : val), z.enum(ASSERTION_TYPES).nullish())
    .describe(
      "Optional assertion type filter ('jsonpath' | 'json_schema' | 'js_expression' | 'tool_call' | 'metric' | 'llm_dim' | 'llm_custom'). Returns all supported schemas if null or omitted.",
    ),
});

export type GetAssertionSchemaInput = z.infer<typeof getAssertionSchemaInputSchema>;

/**
 * Builds the `get_assertion_schema` tool for inspecting unified assertion specifications.
 */
export function buildGetAssertionSchemaTool(ctx: TesterToolContext): ToolDefinition {
  void ctx;
  return defineTool({
    name: "get_assertion_schema",
    description:
      "Inspect the exact JSON Schema definitions, allowed operators, field constraints, and working examples for universal test assertions. Pass the mandatory target test `category` ('verification' | 'evaluation' | 'web-auto'), and optionally filter by `assertionType` ('jsonpath' | 'json_schema' | 'js_expression' | 'tool_call' | 'metric' | 'llm_dim' | 'llm_custom'). If assertionType is omitted or null, returns all schemas applicable to the category.",
    parameters: getAssertionSchemaInputSchema,
    execute: async (args: {
      category: "verification" | "evaluation" | "web-auto";
      assertionType?: AssertionTypeEnum | null;
    }): Promise<GetAssertionSchemaResult> => {
      const validTypes = CATEGORY_TYPE_MAPPING[args.category];

      if (args.assertionType && !validTypes.includes(args.assertionType)) {
        throw new Error(
          `Assertion type '${args.assertionType}' is not supported for category '${args.category}'. Supported types: [${validTypes.join(", ")}]`,
        );
      }

      const targetTypes: AssertionTypeEnum[] = args.assertionType
        ? [args.assertionType]
        : [...validTypes];
      const schemas = targetTypes.map((t) => buildSchemaItem(t, args.category));

      return {
        category: args.category,
        types: targetTypes,
        schemas,
      };
    },
  });
}
