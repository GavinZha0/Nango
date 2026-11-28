/**
 * Client-safe schemas and envelope types for the local shell tools.
 */

import { z } from "zod";

export const LOCAL_SHELL_KINDS = [
  "auto",
  "powershell",
  "cmd",
  "bash",
  "zsh",
  "sh",
] as const;

export type LocalShellKind = (typeof LOCAL_SHELL_KINDS)[number];

export const runLocalCommandArgsSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(16_000)
    .describe(
      "Non-interactive shell command to run on the local host. " +
        "Avoid interactive prompts; stdin is closed.",
    ),
  cwd: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "Working directory for the command. Defaults to the configured workspace " +
        "folder (`host.file.root`). Relative paths resolve inside `host.file.root`; " +
        "absolute host paths are permitted when `host.shell.allow_any_cwd` is enabled.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe(
      "Wall-clock timeout in SECONDS (integer 1-600, NOT milliseconds). " +
        "Ignored when `background` is true. Defaults to `host.shell.timeout` (60s).",
    ),
  shell: z
    .enum(LOCAL_SHELL_KINDS)
    .optional()
    .describe(
      "Shell interpreter override: 'auto' (platform default), 'powershell', 'cmd', 'bash', 'zsh', or 'sh'.",
    ),
  background: z
    .boolean()
    .optional()
    .describe(
      "When true, starts a long-running command in the background and immediately returns a `taskId` " +
        "for `read_local_command_output` and `stop_local_command`. Default false.",
    ),
});

export type RunLocalCommandArgs = z.infer<typeof runLocalCommandArgsSchema>;

export const readLocalCommandOutputArgsSchema = z.object({
  task_id: z
    .string()
    .min(1)
    .max(128)
    .describe("Background task ID returned by `run_local_command` with `background: true`."),
  tail_chars: z
    .number()
    .int()
    .min(100)
    .max(50_000)
    .optional()
    .describe("Maximum trailing characters of captured output to return. Default 12000."),
});

export type ReadLocalCommandOutputArgs = z.infer<typeof readLocalCommandOutputArgsSchema>;

export const stopLocalCommandArgsSchema = z.object({
  task_id: z
    .string()
    .min(1)
    .max(128)
    .describe("Background task ID returned by `run_local_command` with `background: true`."),
});

export type StopLocalCommandArgs = z.infer<typeof stopLocalCommandArgsSchema>;

export type LocalShellErrorCode =
  | "LOCAL_SHELL_DISABLED"
  | "SENSITIVE_ACCESS_DENIED"
  | "INVALID_CWD"
  | "CWD_NOT_FOUND"
  | "SHELL_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "TOO_MANY_TASKS"
  | "EXEC_FAILED";

export interface LocalShellErr {
  ok: false;
  error: LocalShellErrorCode;
  message: string;
  rule?: string;
}

export interface RunLocalCommandSyncResult {
  ok: boolean;
  background: false;
  cwd: string;
  shell: string;
  exitCode: number | null;
  timedOut: boolean;
  canceled: boolean;
  maxBufferExceeded: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
  error?: string;
}

export interface RunLocalCommandBackgroundResult {
  ok: true;
  background: true;
  taskId: string;
  pid: number | null;
  cwd: string;
  shell: string;
  status: "running";
}

export type RunLocalCommandEnvelope =
  | RunLocalCommandSyncResult
  | RunLocalCommandBackgroundResult
  | LocalShellErr;

export interface ReadLocalCommandOutputOk {
  ok: true;
  taskId: string;
  command: string;
  cwd: string;
  shell: string;
  pid: number | null;
  status: "running" | "exited" | "stopped" | "failed";
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
}

export type ReadLocalCommandOutputEnvelope =
  | ReadLocalCommandOutputOk
  | LocalShellErr;

export interface StopLocalCommandOk {
  ok: true;
  taskId: string;
  status: "stopped" | "exited" | "failed";
  exitCode: number | null;
  alreadyFinished: boolean;
}

export type StopLocalCommandEnvelope = StopLocalCommandOk | LocalShellErr;
