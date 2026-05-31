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
import type { SandboxOutput } from "./types";

const RunInSandboxArgs = z.object({
  /** argv array. argv[0] must be a runtime present in the rootfs. */
  command: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Command and arguments as an array (Unix exec style). " +
      "PREFERRED idiom: put the script body in `stdin` and use " +
      "['python3','-'] / ['bash','-'] — this avoids quoting hell. " +
      "Examples: " +
      "['python3','-'] (read Python from stdin, recommended); " +
      "['duckdb','-c','SELECT 1'] (one-shot SQL); " +
      "['bash','-c','python3 - | jq .'] (pipe with stdin code).",
    ),
  /** Content piped to the command's stdin. */
  stdin: z
    .string()
    .optional()
    .describe(
      "Content piped to the command's stdin. Two common uses: " +
      "(1) the SCRIPT BODY itself, paired with command=['python3','-'] " +
      "or ['bash','-'] — preferred over command=['python3','-c','...'] " +
      "for anything beyond a one-liner; " +
      "(2) input DATA the script reads from sys.stdin (CSV / JSON / …).",
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
  // SECONDS, not milliseconds. The field is named explicitly to keep
  // the LLM from defaulting to its setTimeout intuition.
  // Project convention: external surfaces are unitless + seconds;
  // internal vars carry `Ms` suffix; bridged by getConfigMs.
  timeoutSeconds: z
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
      "Execute a command in a sandboxed environment. The sandbox has " +
      "no network access, a read-only rootfs, a writable /tmp, and " +
      "strict memory/CPU/timeout limits. The rootfs ships with " +
      "python3, duckdb, pandas, numpy. Use this for ad-hoc data " +
      "analysis on cached Parquet files. Optional `timeoutSeconds` " +
      "is in SECONDS (NOT milliseconds), integer 1-300, default 30. " +
      "RECOMMENDED CALLING PATTERN — pass the script body via `stdin` " +
      "and run with `command: ['python3','-']` (the `-` makes python " +
      "read source from stdin). This avoids the quoting headaches of " +
      "`python3 -c '...'` and works the same way for `bash`, `duckdb`, " +
      "and other interpreters that accept `-` as stdin. " +
      "Each name passed in `datasets` appears read-only at " +
      "`./data/<name>/` in the sandbox's current working directory — " +
      "construct paths in your script as " +
      "`./data/<name>/**/*.parquet` and read with " +
      "duckdb.read_parquet(...). The cwd is also writable, so " +
      "intermediate files (plots, intermediate Parquets, etc.) can " +
      "be saved next to the data with `./output.png`, " +
      "`./scratch.parquet`, etc. Returns " +
      "{ stdout, stderr, exitCode, durationMs, termination }.",
    parameters: RunInSandboxArgs,
    execute: async (args) => {
      const adapter = await getActiveAdapter();
      const out: SandboxOutput = await adapter.run({
        command: args.command,
        stdin: args.stdin,
        datasets: args.datasets,
        // Convert seconds → ms at the boundary; internals stay
        // millisecond-typed throughout (project convention).
        timeoutMs:
          args.timeoutSeconds != null
            ? args.timeoutSeconds * 1000
            : undefined,
      });
      return {
        stdout: out.stdout,
        stderr: out.stderr,
        exitCode: out.exitCode,
        durationMs: out.durationMs,
        ...(out.termination ? { termination: out.termination } : {}),
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
