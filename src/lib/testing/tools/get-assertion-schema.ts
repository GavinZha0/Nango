import "server-only";

import { z } from "zod";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  jsonPathAssertionSchema,
  jsonSchemaAssertionSchema,
  jsExpressionAssertionSchema,
  toolCallAssertionSchema,
  metricAssertionSchema,
  llmJudgeAssertionSchema,
} from "@/lib/assertions/types";
import {
  ASSERTION_TYPES,
  type AssertionTypeEnum,
  type AssertionSchemaItem,
  type GetAssertionSchemaResult,
  type TesterToolContext,
} from "../types";

const CATEGORY_TYPE_MAPPING: Record<
  "verification" | "evaluation" | "web-auto",
  AssertionTypeEnum[]
> = {
  verification: ["jsonpath", "json_schema", "js_expression"],
  evaluation: ["jsonpath", "js_expression", "llm_judge", "metric", "tool_call"],
  "web-auto": ["js_expression", "jsonpath", "llm_judge"],
};

function buildSchemaItem(type: AssertionTypeEnum): AssertionSchemaItem {
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
          "Executes a custom JavaScript expression in a secure VM sandbox against output variables (e.g. `output.items.length > 0`). Passes if expression evaluates to truthy.",
        jsonSchema: cleanSchema,
        example: {
          type: "js_expression",
          expression: "Array.isArray(output.items) && output.items.length > 0",
        },
      };
    }
    case "tool_call": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(toolCallAssertionSchema) as Record<string, unknown>;
      return {
        type: "tool_call",
        description:
          "Verifies agent tool invocation trajectories during evaluation runs, checking that expected tools were called with valid argument subsets (expectedArgs) and invocation counts (expectedCalls).",
        jsonSchema: cleanSchema,
        example: {
          type: "tool_call",
          toolName: "fetch_calendar_events",
          expectedCalls: 1,
          expectedArgs: { days: 7 },
        },
      };
    }
    case "metric": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(metricAssertionSchema) as Record<string, unknown>;
      return {
        type: "metric",
        description:
          "Asserts numerical performance constraints including duration_s (execution seconds), output_tokens, or total_tool_calls using comparison operators (<, <=, >, >=, ==).",
        jsonSchema: cleanSchema,
        example: {
          type: "metric",
          metric: "duration_s",
          operator: "<=",
          threshold: 5.0,
        },
      };
    }
    case "llm_judge": {
      const { $schema, ...cleanSchema } = z.toJSONSchema(llmJudgeAssertionSchema) as Record<string, unknown>;
      return {
        type: "llm_judge",
        description:
          "Evaluates conversational responses or visual UI states using LLM-as-Judge semantic criteria. Specify expected behavior (expectation), prohibited behavior (unexpectation), and ground truth reference.",
        jsonSchema: cleanSchema,
        example: {
          type: "llm_judge",
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
  assertionType: z
    .enum(ASSERTION_TYPES)
    .nullish()
    .describe(
      "Optional assertion type filter ('jsonpath' | 'json_schema' | 'js_expression' | 'tool_call' | 'metric' | 'llm_judge'). Returns all supported schemas if null or omitted.",
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
      "Inspect the exact JSON Schema definitions, allowed operators, field constraints, and working examples for universal test assertions. Pass the mandatory target test `category` ('verification' | 'evaluation' | 'web-auto'), and optionally filter by `assertionType` ('jsonpath' | 'json_schema' | 'js_expression' | 'tool_call' | 'metric' | 'llm_judge'). If assertionType is omitted or null, returns all schemas applicable to the category.",
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

      const targetTypes = args.assertionType ? [args.assertionType] : validTypes;
      const schemas = targetTypes.map((t) => buildSchemaItem(t));

      return {
        category: args.category,
        types: targetTypes,
        schemas,
      };
    },
  });
}
