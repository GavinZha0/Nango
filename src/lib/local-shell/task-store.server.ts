/**
 * In-process background task store for long-running local shell commands.
 *
 * Pinned to `globalThis` so Next.js dev/Turbopack module realms share one
 * registry and `instrumentation.ts` shutdown hooks reap every spawned tree.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import type { ResultPromise } from "execa";
import stripAnsi from "strip-ansi";

import { killProcessTree } from "@/lib/mcp/stdio-spawn.server";

import { redactShellOutput } from "./redact.server";
import type {
  LocalShellErr,
  ReadLocalCommandOutputEnvelope,
  StopLocalCommandEnvelope,
} from "./schema";

const MAX_CONCURRENT_RUNNING = 10;
const MAX_RETAINED_FINISHED = 50;
const FINISHED_TASK_TTL_MS = 30 * 60 * 1000;
const MAX_RING_BUFFER_CHARS = 256 * 1024;
const DEFAULT_TAIL_CHARS = 12_000;

export type BackgroundTaskStatus = "running" | "exited" | "stopped" | "failed";

interface BackgroundTaskEntry {
  taskId: string;
  command: string;
  cwd: string;
  shell: string;
  pid: number | null;
  startedAt: number;
  finishedAt: number | null;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  buffer: string;
  droppedChars: number;
  subprocess: ResultPromise | null;
}

interface TaskStoreState {
  tasks: Map<string, BackgroundTaskEntry>;
}

const G = globalThis as { __nango_local_shell_tasks?: TaskStoreState };
G.__nango_local_shell_tasks ??= { tasks: new Map() };
const store: TaskStoreState = G.__nango_local_shell_tasks;

function pruneFinishedTasks(): void {
  const now = Date.now();
  const finished: BackgroundTaskEntry[] = [];
  for (const entry of store.tasks.values()) {
    if (entry.status !== "running") {
      if (
        entry.finishedAt !== null &&
        now - entry.finishedAt > FINISHED_TASK_TTL_MS
      ) {
        store.tasks.delete(entry.taskId);
      } else {
        finished.push(entry);
      }
    }
  }
  if (finished.length > MAX_RETAINED_FINISHED) {
    finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const excess = finished.length - MAX_RETAINED_FINISHED;
    for (let i = 0; i < excess; i += 1) {
      store.tasks.delete(finished[i]!.taskId);
    }
  }
}

function appendOutput(entry: BackgroundTaskEntry, chunk: string): void {
  const cleaned = stripAnsi(chunk);
  if (!cleaned) return;
  entry.buffer += cleaned;
  if (entry.buffer.length > MAX_RING_BUFFER_CHARS) {
    const excess = entry.buffer.length - MAX_RING_BUFFER_CHARS;
    entry.buffer = entry.buffer.slice(excess);
    entry.droppedChars += excess;
  }
}

export function countRunningLocalShellTasks(): number {
  let count = 0;
  for (const entry of store.tasks.values()) {
    if (entry.status === "running") count += 1;
  }
  return count;
}

export function canStartBackgroundTask(): boolean {
  pruneFinishedTasks();
  return countRunningLocalShellTasks() < MAX_CONCURRENT_RUNNING;
}

/**
 * Register a newly spawned background `execa` subprocess and capture its
 * combined output stream into a bounded ring buffer.
 */
export function registerBackgroundTask(params: {
  command: string;
  cwd: string;
  shell: string;
  subprocess: ResultPromise;
}): { taskId: string; pid: number | null } {
  pruneFinishedTasks();

  const taskId = `cmd_${randomUUID().slice(0, 12)}`;
  const pid = typeof params.subprocess.pid === "number" ? params.subprocess.pid : null;

  const entry: BackgroundTaskEntry = {
    taskId,
    command: params.command,
    cwd: params.cwd,
    shell: params.shell,
    pid,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    exitCode: null,
    buffer: "",
    droppedChars: 0,
    subprocess: params.subprocess,
  };

  store.tasks.set(taskId, entry);

  const stream = params.subprocess.all ?? params.subprocess.stdout;
  if (stream) {
    stream.on("data", (chunk: unknown) => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
      appendOutput(entry, text);
    });
  }

  void params.subprocess
    .then((res) => {
      entry.finishedAt = Date.now();
      entry.subprocess = null;
      entry.exitCode = typeof res.exitCode === "number" ? res.exitCode : null;
      if (entry.status === "running") {
        entry.status = res.exitCode === 0 ? "exited" : "failed";
      }
    })
    .catch((err: unknown) => {
      entry.finishedAt = Date.now();
      entry.subprocess = null;
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(entry, `\n${msg}\n`);
      if (entry.status === "running") {
        entry.status = "failed";
      }
    });

  return { taskId, pid };
}

/**
 * Read recent redacted output and status for a background task.
 */
export function readBackgroundTaskOutput(
  taskId: string,
  tailChars: number = DEFAULT_TAIL_CHARS,
): ReadLocalCommandOutputEnvelope {
  pruneFinishedTasks();
  const entry = store.tasks.get(taskId);
  if (!entry) {
    const err: LocalShellErr = {
      ok: false,
      error: "TASK_NOT_FOUND",
      message: `No background local command task found with id "${taskId}".`,
    };
    return err;
  }

  const redacted = redactShellOutput(entry.buffer);
  const clampedTail = Math.max(100, Math.min(50_000, Math.floor(tailChars)));
  const truncated = entry.droppedChars > 0 || redacted.length > clampedTail;
  const output =
    redacted.length > clampedTail
      ? `... [truncated earlier output] ...\n${redacted.slice(-clampedTail)}`
      : entry.droppedChars > 0
        ? `... [dropped ${entry.droppedChars} earlier chars] ...\n${redacted}`
        : redacted;

  const endTime = entry.finishedAt ?? Date.now();

  return {
    ok: true,
    taskId: entry.taskId,
    command: entry.command,
    cwd: entry.cwd,
    shell: entry.shell,
    pid: entry.pid,
    status: entry.status,
    exitCode: entry.exitCode,
    durationMs: Math.max(0, endTime - entry.startedAt),
    output,
    truncated,
  };
}

/**
 * Terminate a running background task and its entire descendant process tree.
 */
export async function stopBackgroundTask(
  taskId: string,
): Promise<StopLocalCommandEnvelope> {
  const entry = store.tasks.get(taskId);
  if (!entry) {
    return {
      ok: false,
      error: "TASK_NOT_FOUND",
      message: `No background local command task found with id "${taskId}".`,
    };
  }

  if (entry.status !== "running") {
    return {
      ok: true,
      taskId: entry.taskId,
      status: entry.status,
      exitCode: entry.exitCode,
      alreadyFinished: true,
    };
  }

  entry.status = "stopped";
  const proc = entry.subprocess;
  const pid = entry.pid;

  if (typeof pid === "number" && pid > 0) {
    await Promise.race([
      killProcessTree(pid),
      new Promise((r) => setTimeout(r, 1_500)),
    ]);
  }
  if (proc) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited
    }
    await Promise.race([
      proc.catch(() => undefined),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
  }

  entry.finishedAt ??= Date.now();
  entry.subprocess = null;

  return {
    ok: true,
    taskId: entry.taskId,
    status: "stopped",
    exitCode: entry.exitCode,
    alreadyFinished: false,
  };
}

/**
 * Stop every running background local shell task on server shutdown.
 */
export async function shutdownAllLocalShellTasks(): Promise<void> {
  const runningIds: string[] = [];
  for (const entry of store.tasks.values()) {
    if (entry.status === "running") {
      runningIds.push(entry.taskId);
    }
  }
  await Promise.all(runningIds.map((id) => stopBackgroundTask(id)));
  store.tasks.clear();
}

/** Clear store state (for unit tests). */
export function _clearLocalShellTaskStore(): void {
  store.tasks.clear();
}
