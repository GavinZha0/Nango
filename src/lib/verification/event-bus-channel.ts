/**
 * Verification — SSE publishing helper.
 *
 * Thin wrapper over the runner event-bus so callers don't have to
 * know the envelope shape. See docs/verification.md.
 */

import "server-only";

import { publish } from "@/lib/runner/event-bus";

import type { VerificationFrame } from "./types";

/**
 * Publish a {@link VerificationFrame} to the owner's per-process SSE
 * channel. The frame is wrapped in `{kind: "verification", ownerId,
 * frame}` so `/api/runs/stream` can multiplex with the other event
 * kinds (`notification`, `run_finalized`).
 *
 * CONTRACT: best-effort — `publish` itself is in-process and can't
 * throw. If no subscriber exists for `ownerId` the frame is dropped.
 */
export function publishVerificationFrame(
  ownerId: string,
  frame: VerificationFrame,
): void {
  publish(ownerId, { kind: "verification", ownerId, frame });
}
