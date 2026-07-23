/**
 * Server-side `run_code_in_sandbox` agent tool.
 *
 * See docs/sandbox.md.
 */

import "server-only";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { z } from "zod";

import { getActiveAdapter } from "./registry.server";
import { assembleCodeOutput } from "./code-output";
import { BackendUnavailableError } from "./errors";
import { scanCodeStatic } from "./static-scan";

const RunInSandboxArgs = z.object({
  /** Interpreter to execute `code_text` in. Maps to a fixed
   *  argv internally (python → `["python3","-"]`); the LLM never
   *  picks the argv directly. */
  language: z
    .enum(["python", "javascript"])
    .describe(
      "Interpreter to run `code_text` in. 'python' (python3) for " +
        "data analysis with duckdb/pandas/numpy; 'javascript' (node) " +
        "for general scripting. Both read from stdin.",
    ),
  /** Source body piped to the interpreter's stdin. */
  code_text: z
    .string()
    .min(1)
    .describe(
      "Source body to execute. Passed verbatim on the interpreter's " +
        "stdin — no quoting / escaping required. For Python this is " +
        "the script body; the runtime reads it via `python3 -`. " +
        "Data the script needs at runtime should go through " +
        "`params` (env vars) or the dataset files exposed under " +
        "./data/<name>/.",
    ),
  /** Datasets to expose read-only under `./data/<name>/` in the
   *  sandbox's current working directory. The data-source layer
   *  must already have materialised them via `extract_dataset_by_sql`.
   *
   *  Backend mechanism (transparent to the LLM):
   *    subprocess: `<tmpHostDir>/data/<name>` symlink → cache
   *    docker:     `/work/data/<name>` bind mount (--workdir /work)
   *  Either way, in-sandbox code reads `./data/<name>/...`. */
  datasets: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Cached dataset names to expose read-only at ./data/<name>/ (relative to the sandbox's current working directory). Materialise them first with extract_dataset_by_sql.",
    ),
  /** Free-form parameters serialised into the sandbox process'
   *  env vars. Use for small typed inputs the code reads via
   *  `os.environ['THRESHOLD']`. Non-string values are stringified
   *  at the boundary. Keep secrets out — env vars are visible to
   *  any subprocess the code spawns. */
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Parameters serialised into the sandbox process env. Read " +
        "with `os.environ['<KEY>']`. Non-string values are coerced " +
        "to strings. Do NOT put secrets here.",
    ),
  // SECONDS, not milliseconds. The field is named explicitly to keep
  // the LLM from defaulting to its setTimeout intuition.
  // Project convention: external surfaces are unitless + seconds;
  // internal vars carry `Ms` suffix; bridged by getConfigMs.
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "Wall-clock timeout in SECONDS (integer 1-300). NOT milliseconds. " +
        "Default is 30 seconds.",
    ),
});

/** Per-language argv table the sandbox adapter executes. */
const LANGUAGE_COMMAND: Record<"python" | "javascript", readonly string[]> = {
  python: ["python3", "-"],
  javascript: ["node", "--input-type=module", "-"],
} as const;

/**
 * Build the `run_in_sandbox` tool definition.
 *
 * The tool is stateless: each call lands in `getActiveAdapter().run(...)`
 * which spins up a fresh sandbox, runs the command, tears down. No
 * session state.
 */
export function buildRunInSandboxTool(): ToolDefinition {
  return defineTool({
    name: "run_code_in_sandbox",
    description:
      "Execute source code in a sandboxed environment. The sandbox " +
      "has no network access, a read-only rootfs, a writable /tmp, " +
      "and strict memory/CPU/timeout limits. Two languages: " +
      "'python' (python3 with duckdb, pandas, numpy — best for " +
      "data analysis on cached Parquet files) and 'javascript' " +
      "(node — for general scripting). Pick the interpreter via " +
      "`language` and pass the script body via `code_text` — the " +
      "tool handles the argv internally (python → `python3 -`, " +
      "javascript → `node -`). " +
      "Optional `timeout_seconds` is in SECONDS (NOT milliseconds), " +
      "integer 1-300, default 30. Pass typed runtime parameters via " +
      "`params` (env vars; read with `os.environ['<KEY>']` in " +
      "Python or `process.env['<KEY>']` in JavaScript); do not " +
      "embed secrets there. Each name passed in `datasets` appears " +
      "read-only at `./data/<name>/` in the sandbox's current " +
      "working directory — construct paths in your script as " +
      "`./data/<name>/**/*.parquet` and read with " +
      "`duckdb.read_parquet(...)`. The cwd is also writable, so " +
      "intermediate files (plots, intermediate Parquets, etc.) can " +
      "be saved next to the data with `./output.png`, " +
      "`./scratch.parquet`, etc. " +
      "IMPORTANT OUTPUT CONVENTION: Your code MUST print exactly one JSON object to stdout containing a 'rows' array and an optional 'message'. " +
      "For example in JS: console.log(JSON.stringify({ rows: [...], message: '...' })); or in Python: print(json.dumps({'rows': [...], 'message': '...'})). " +
      "Do NOT print raw arrays or other text to stdout. " +
      "Returns CodeOutputEnvelope { ok, duration_ms, rows, row_count, row_schema, message, files, error } plus backend.",
    parameters: RunInSandboxArgs,
    execute: async (args) => {
      // Node 9: Pre-execution Static Security Scan (AST & pattern inspection)
      const scanResult = scanCodeStatic(args.code_text, args.language);
      if (!scanResult.passed) {
        return {
          ok: false,
          duration_ms: 0,
          rows: null,
          row_count: null,
          row_schema: null,
          message: null,
          files: null,
          error: `[Node 9 Static Security Scan Failed]: ${scanResult.violations.map((v) => v.message).join("; ")}`,
          backend: null,
        };
      }

      let adapter;
      try {
        adapter = await getActiveAdapter();
      } catch (err) {
        // SECURITY (BUG-11): fail-closed — surface the "no isolated
        // sandbox configured" refusal as a structured envelope instead
        // of executing or throwing a raw error.
        if (err instanceof BackendUnavailableError) {
          return {
            ok: false,
            duration_ms: 0,
            rows: null,
            row_count: null,
            row_schema: null,
            message: null,
            files: null,
            error: err.message,
            backend: null,
          };
        }
        throw err;
      }
      const command = LANGUAGE_COMMAND[args.language];
      // QUIRK: `params` is accepted at the tool boundary but not
      // yet plumbed into the sandbox env — the SandboxInput
      // adapter contract has no per-call env overlay (only the
      // operator-tuned allowlist). The workflow code-node
      // executor has the same limitation. Wiring lands when the
      // sandbox adapters grow an `env?: Record<string, string>`
      // slot.
      const out = await adapter.run({
        command: [...command],
        stdin: args.code_text,
        datasets: args.datasets,
        // Convert seconds → ms at the boundary; internals stay
        // millisecond-typed throughout (project convention).
        timeoutMs:
          args.timeout_seconds != null
            ? args.timeout_seconds * 1000
            : undefined,
      });
      return {
        ...assembleCodeOutput(out),
        backend: adapter.backend,
      };
    },
  });
}

/** Convenience for runtime wiring: the same tool plus an empty
 *  prompt block (kept symmetric with `buildSkillsRuntime` in case
 *  we want a "Code execution" capabilities section later). */
export interface SandboxRuntime {
  tools: ToolDefinition[];
  promptBlock: string;
}

export function buildSandboxRuntime(): SandboxRuntime {
  return {
    tools: [buildRunInSandboxTool()],
    promptBlock: "",
  };
}
