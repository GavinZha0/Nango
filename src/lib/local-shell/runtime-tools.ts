/**
 * Server-side local shell agent tools:
 *  - `run_local_command` (toggleable in `BUILTIN_TOOLS`)
 *  - `read_local_command_output` (auto-mounted alongside `run_local_command`)
 *  - `stop_local_command` (auto-mounted alongside `run_local_command`)
 */

import "server-only";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";

import { executeLocalCommand } from "./executor.server";
import {
  readLocalCommandOutputArgsSchema,
  runLocalCommandArgsSchema,
  stopLocalCommandArgsSchema,
  type ReadLocalCommandOutputEnvelope,
  type RunLocalCommandEnvelope,
  type StopLocalCommandEnvelope,
} from "./schema";
import {
  readBackgroundTaskOutput,
  stopBackgroundTask,
} from "./task-store.server";

export function buildRunLocalCommandTool(): ToolDefinition {
  return defineTool({
    name: "run_local_command",
    description:
      "Execute a non-interactive shell command on the local host machine (Windows PowerShell/CMD or macOS/Linux zsh/bash). " +
      "Stdin is closed so interactive prompts are unsupported; pass non-interactive flags (e.g. `-y`, `--yes`). " +
      "Defaults `cwd` to the configured workspace folder (`host.file.root`); pass a relative path or an absolute directory path when needed. " +
      "For long-running commands (dev servers, watchers, long builds), set `background: true` to receive a `taskId`, then inspect output with `read_local_command_output` and stop it with `stop_local_command`. " +
      "Subprocesses run with a strict minimal environment allowlist and cannot access `.env` files, host credential stores, or sensitive API keys. " +
      "Returns `{ ok, background, cwd, shell, exitCode, timedOut, canceled, durationMs, output, truncated }` (or `{ ok: true, background: true, taskId, pid, cwd, shell, status }` in background mode).",
    parameters: runLocalCommandArgsSchema,
    execute: async (
      args,
      ctx?: { abortSignal?: AbortSignal },
    ): Promise<RunLocalCommandEnvelope> => {
      return executeLocalCommand(args, { abortSignal: ctx?.abortSignal });
    },
  });
}

export function buildReadLocalCommandOutputTool(): ToolDefinition {
  return defineTool({
    name: "read_local_command_output",
    description:
      "Check status and read recent captured output of a background command started via `run_local_command(background: true)`.",
    parameters: readLocalCommandOutputArgsSchema,
    execute: async (args): Promise<ReadLocalCommandOutputEnvelope> => {
      return readBackgroundTaskOutput(args.task_id, args.tail_chars);
    },
  });
}

export function buildStopLocalCommandTool(): ToolDefinition {
  return defineTool({
    name: "stop_local_command",
    description:
      "Terminate a running background command (and its descendant processes) started via `run_local_command(background: true)`.",
    parameters: stopLocalCommandArgsSchema,
    execute: async (args): Promise<StopLocalCommandEnvelope> => {
      return stopBackgroundTask(args.task_id);
    },
  });
}
