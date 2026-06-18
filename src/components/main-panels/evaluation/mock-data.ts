/**
 * Mock data for evaluation UI prototyping.
 * Will be replaced by real API responses once DB schema is finalized.
 */

// Dimension pool — system-level predefined + user-custom
// Categories mirror the Langfuse evaluation framework.

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
  "RAG",
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

  // 3. RAG (Retrieval-Augmented Generation)
  { id: "context-relevance", name: "Context Relevance", category: "RAG", description: "Whether the retrieved context contributes to generating a quality answer",              builtin: true },
  { id: "answer-relevancy",  name: "Answer Relevancy",  category: "RAG", description: "How relevant the generated answer is to the user's original question",                 builtin: true },

  // 4. Agent & Reasoning
  { id: "topic-adherence",   name: "Topic Adherence",      category: "Agent & Reasoning", description: "Whether the model stays on the preset topic during interaction",                   builtin: true },
  { id: "goal-accuracy",     name: "Goal Accuracy",        category: "Agent & Reasoning", description: "Whether the final output truly satisfies the user's business requirement",        builtin: true },
  { id: "exec-completeness", name: "Exec Completeness",    category: "Agent & Reasoning", description: "Whether every step of the instruction was actually executed with logical support", builtin: true },
  { id: "tool-usage",        name: "Tool Usage",           category: "Agent & Reasoning", description: "Whether external APIs or tools were called correctly and appropriately",          builtin: true },

  // 5. Format & Domain
  { id: "format-compliance", name: "Format Compliance", category: "Format & Domain", description: "Whether the output strictly follows the prescribed JSON, XML, or structural format", builtin: true },
  { id: "sql-equivalence",   name: "SQL Equivalence",   category: "Format & Domain", description: "Whether the generated SQL query is logically equivalent to the reference query",    builtin: true },
];

// Case-level evaluation criteria (conversation-level, not per-turn).
// Two evaluation paths: LLM-evaluated + deterministic assertions.

export interface EvalCriteria {
  // ─── LLM-evaluated (sent to evaluator agent as context) ───
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

// Turn — one round of user→agent interaction within a case

export interface EvalTurn {
  /** User message — sent to the agent during test execution. */
  userMessage: string;
  // Fields below are populated by the execution engine, empty at definition time.
  actualResponse?: string;
  toolCalls?: Array<{ name: string; args: string; result: string }>;
}

// Case

export interface EvalCase {
  id: string;
  name: string;
  turns: EvalTurn[];
  /** Conversation-level evaluation criteria. */
  criteria: EvalCriteria;
  /** Dimension override — null means inherit from suite. */
  dimensionOverride: string[] | null;
  /** Last evaluation result. */
  lastStatus: "pass" | "fail" | "error" | "pending" | null;
  lastScore: number | null;
  /** Per-dimension scores from last evaluation. */
  lastDimensionScores: Record<string, number> | null;
  lastFeedback: string | null;
  // Objective metrics — measured by the execution engine, not the evaluator.
  /** Time to first token in milliseconds. */
  lastTtftMs: number | null;
  /** Total end-to-end duration in milliseconds. */
  lastDurationMs: number | null;
  /** Total token usage (input + output). */
  lastTokens: number | null;
}

// Suite

export interface EvalSuite {
  id: string;
  name: string;
  description: string | null;
  evalAgentName: string;
  evalAgentIcon: string;
  enabled: boolean;
  /** Dimension IDs selected for this suite (from the pool). */
  dimensionIds: string[];
  cases: EvalCase[];
}

// Run history entry — one batch evaluation execution

export interface EvalRunSummary {
  id: string;
  /** Overall score across all cases in this run (0-100). */
  score: number;
  status: "pass" | "fail" | "error";
  /** ISO 8601 timestamp. */
  ranAt: string;
  casesTotal: number;
  casesPassed: number;
}

// Agent-level config

export interface EvalAgentConfig {
  id: string;
  agentName: string;
  agentIcon: string;
  suites: EvalSuite[];
  /** Historical run summaries — newest first. */
  runHistory: EvalRunSummary[];
}

// No mock data — UI is wired to the database via Zustand stores.
// Types above (EvalCriteria, EvalTurn, EvalCase, EvalSuite, etc.) and
// constants (BUILTIN_DIMENSIONS, DIMENSION_CATEGORIES) are still used
// by UI components for display and editing.
