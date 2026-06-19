export interface EvalDimension {
  id: string;
  name: string;
  category: string;
  description: string;
  builtin: boolean;
}

export const DIMENSION_CATEGORIES = [
  "Text Quality",
  "Factuality",
  "Agent & Reasoning",
  "Format & Domain",
] as const;

export const BUILTIN_DIMENSIONS: EvalDimension[] = [
  // 1. Text Quality & Logic
  { id: "helpfulness",  name: "Helpfulness",    category: "Text Quality", description: "How well the response addresses the user's actual need",                             builtin: true },
  { id: "coherence",    name: "Coherence",      category: "Text Quality", description: "Whether the text is linguistically fluent with logical flow between sentences",        builtin: true },
  { id: "conciseness",  name: "Conciseness",    category: "Text Quality", description: "Whether the response is direct and avoids unnecessary verbosity",                     builtin: true },
  { id: "toxicity",     name: "Toxicity",       category: "Text Quality", description: "Whether the output contains offensive, harmful, or biased content",                   builtin: true },
  { id: "tone",         name: "Tone",           category: "Text Quality", description: "Professional, empathetic, and context-appropriate language",                           builtin: true },

  // 2. Factuality & Hallucination
  { id: "hallucination",  name: "Hallucination",    category: "Factuality", description: "Whether the model fabricated statements without factual basis",                      builtin: true },
  { id: "faithfulness",   name: "Faithfulness",     category: "Factuality", description: "Whether the answer is faithful to the provided context without deviating from facts",  builtin: true },

  // 3. Agent & Reasoning
  { id: "topic-adherence",   name: "Topic Adherence",      category: "Agent & Reasoning", description: "Whether the model stays on the preset topic during interaction",                   builtin: true },
  { id: "goal-accuracy",     name: "Goal Accuracy",        category: "Agent & Reasoning", description: "Whether the final output truly satisfies the user's business requirement",        builtin: true },
  { id: "exec-completeness", name: "Exec Completeness",    category: "Agent & Reasoning", description: "Whether every step of the instruction was actually executed with logical support", builtin: true },
  { id: "tool-usage",        name: "Tool Usage",           category: "Agent & Reasoning", description: "Whether external APIs or tools were called correctly and appropriately",          builtin: true },

  // 4. Format & Domain
  { id: "format-compliance", name: "Format Compliance", category: "Format & Domain", description: "Whether the output strictly follows the prescribed JSON, XML, or structural format", builtin: true },
  { id: "sql-equivalence",   name: "SQL Equivalence",   category: "Format & Domain", description: "Whether the generated SQL query is logically equivalent to the reference query",    builtin: true },
];

export interface EvalCriteria {
  // ─── LLM-evaluated (sent to evaluator agent as context) ───
  /** User-reported problem observed during conversation.
   *  Typically captured via SaveToEvalDialog when the user flags a
   *  chat as problematic. Guides the evaluator to focus on this
   *  specific deficiency. */
  issue?: string;
  /** Natural language description of the expected outcome. */
  expected_outcome?: string;
  /** Reference answer / ground truth. */
  reference?: string;
  /** Supplementary context (business rules, knowledge snippets). */
  context?: string[];

  // ─── Deterministic (verified by code, results fed to evaluator) ───
  /** Tool names that should be called during the conversation. */
  tool_calls?: string[];
  /** Keywords that must appear in the agent's response. */
  expected_keywords?: string[];
  /** Keywords that must NOT appear. */
  unexpected_keywords?: string[];
  /** Expression-style assertions, e.g. "entity_name == \"abc\"", "duration_ms <= 5000".
   *  Reserved paths: duration_ms, tokens, ttft_ms (execution metrics). */
  assertions?: string[];
}

import { z } from "zod";

/** Runtime Zod schema matching {@link EvalCriteria}.
 *  `.passthrough()` keeps forward compatibility — unknown fields are
 *  preserved (not stripped) so future additions don't break existing
 *  API callers. */
export const evalCriteriaSchema = z
  .object({
    issue: z.string().optional(),
    expected_outcome: z.string().optional(),
    reference: z.string().optional(),
    context: z.array(z.string()).optional(),
    tool_calls: z.array(z.string()).optional(),
    expected_keywords: z.array(z.string()).optional(),
    unexpected_keywords: z.array(z.string()).optional(),
    assertions: z.array(z.string()).optional(),
  })
  .passthrough();

export interface EvalTurn {
  /** User message — sent to the agent during test execution. */
  userMessage: string;
  // Fields below are populated by the execution engine, empty at definition time.
  actualResponse?: string;
  toolCalls?: Array<{ name: string; args: string; result: string }>;
}
