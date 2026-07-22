/**
 * Agent pipeline — Tool-layer middleware types.
 *
 * The composable replacement for the ad-hoc `wrapToolExecute` /
 * `wrapToolApproval` decorators (see docs/architecture-improvements.md
 * "P0 — Agent Middleware Pipeline"). `wrapToolCall` is the primitive
 * (around); `beforeToolCall` / `afterToolResult` are sugar over it
 * (see `defineToolMiddleware`).
 *
 * Scope: local-enforce paths only (built-in / workflow / verification /
 * evaluation). Backend-platform tools run upstream and are observe-only.
 */

import "server-only";

import type { AgentRole } from "@/lib/db/schema";

/**
 * Per-run context shared across middlewares. `metadata` is the mutable
 * scratchpad for cross-middleware enrichment (e.g. loop-detection state).
 */
export interface MiddlewareContext {
  /** Absent for non-run / warm-up contexts (no approval / persistence). */
  readonly runId?: string;
  readonly userId: string;
  readonly agentId?: string;
  readonly threadId?: string;
  readonly agentRole?: AgentRole | null;
  /** Plumbed now; consumed by the headless-deny policy in N1-B. */
  readonly isHeadless: boolean;
  readonly metadata: Record<string, unknown>;
}

/**
 * The tool invocation the pipeline mediates. `args` is the tool's
 * execute argument (execute's `args[0]`); `toolCallId` is the AI SDK
 * option (`args[1].toolCallId`). N1-A does not mutate `args`.
 */
export interface ToolCall {
  readonly toolName: string;
  readonly args: unknown;
  readonly toolCallId?: string;
}

/** Inner continuation — the next middleware, or finally the tool's execute. */
export type ToolNext = (call: ToolCall) => Promise<unknown>;

/**
 * Tool-layer middleware. `order`: lower = OUTER (runs first inbound,
 * last outbound). A middleware may inspect/short-circuit (return without
 * calling `next`), transform `next()`'s result, or catch throws.
 */
export interface ToolMiddleware {
  readonly name: string;
  readonly order: number;
  wrapToolCall(ctx: MiddlewareContext, call: ToolCall, next: ToolNext): Promise<unknown>;
}

/** Decision returned by a `beforeToolCall` hook. */
export type BeforeDecision =
  | { action: "pass" }
  | { action: "block"; result: unknown };

/**
 * Ergonomic middleware spec: provide EITHER the `wrapToolCall` primitive
 * (around) OR the `beforeToolCall` / `afterToolResult` hooks. When
 * `wrapToolCall` is present it wins. Normalized by `defineToolMiddleware`.
 */
export interface ToolMiddlewareSpec {
  readonly name: string;
  readonly order: number;
  /** Pre-execute gate — return `block` to short-circuit with `result`. */
  beforeToolCall?(ctx: MiddlewareContext, call: ToolCall): Promise<BeforeDecision> | BeforeDecision;
  /** Post-execute transform of a successful result (does NOT see throws). */
  afterToolResult?(ctx: MiddlewareContext, call: ToolCall, result: unknown): Promise<unknown> | unknown;
  /** Around primitive — full control (catch throws, wrap, short-circuit). */
  wrapToolCall?(ctx: MiddlewareContext, call: ToolCall, next: ToolNext): Promise<unknown>;
}
