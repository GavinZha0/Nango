/**
 * Server-side notification authoring. The runner calls
 */

import "server-only";

import { db } from "@/lib/db";
import {
  NotificationTable,
  type NotificationEntity,
  type NotificationKind,
} from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";
import { publish } from "./event-bus";

const log = childLogger({ component: "notifications" });

/** Inbox preview cap; full output stays in entity_run / events. */
const BODY_PREVIEW_CHARS = 280;
/** Hard cap on `full_body` (~16 KB) keeps the row sane on huge LLM
 *  outputs; full fidelity remains in entity_run_event. */
const FULL_BODY_MAX_CHARS = 16 * 1024;

/**
 * Sanitise + truncate for `notification.body`. SECURITY: Postgres
 * TEXT rejects NUL bytes (`\x00`); LLM streams splice them in
 * occasionally and the insert would otherwise blow up.
 */
export function previewBody(text: string | null | undefined): string | null {
  if (!text) return null;
  const sanitised = text.replace(/\u0000/g, "");
  const trimmed = sanitised.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > BODY_PREVIEW_CHARS
    ? `${trimmed.slice(0, BODY_PREVIEW_CHARS)}…`
    : trimmed;
}

/** Same NUL-strip as preview but at the higher cap. */
function fullBody(text: string | null | undefined): string | null {
  if (!text) return null;
  const sanitised = text.replace(/\u0000/g, "");
  const trimmed = sanitised.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > FULL_BODY_MAX_CHARS
    ? `${trimmed.slice(0, FULL_BODY_MAX_CHARS)}…`
    : trimmed;
}

interface RecordRunNotificationInput {
  ownerId: string;
  runId: string;
  kind: Extract<NotificationKind, "run_completed" | "run_failed">;
  title: string;
  /** Full specialist output / error. Preview computed for `body`,
   *  full text under `full_body`. */
  body?: string | null;
  /** Display label of the source agent at notification time — frozen
   *  here so it survives later renames / deletions. */
  sourceLabel?: string | null;
  /** Original prompt snapshot — pairs the answer with the question. */
  task?: string | null;
}

/**
 * Insert + publish in one shot. CONTRACT: best-effort — if the DB
 * write fails we log and continue. The run's status / events are
 * already persisted; the user can still navigate to run history.
 */
export async function recordRunNotification(
  input: RecordRunNotificationInput,
): Promise<NotificationEntity | null> {
  try {
    const [row] = await db
      .insert(NotificationTable)
      .values({
        ownerId: input.ownerId,
        kind: input.kind,
        title: input.title,
        body: previewBody(input.body),
        fullBody: fullBody(input.body),
        sourceLabel: input.sourceLabel ?? null,
        // Same sanitisation for tasks (NUL-strip + 16KB cap).
        task: fullBody(input.task),
        runId: input.runId,
      })
      .returning();
    publish(input.ownerId, { kind: "notification", notification: row });
    return row;
  } catch (err) {
    // QUIRK: drizzle-orm wraps the postgres reason in `.cause` and
    // only shows "Failed query: …" in `.message` — without the cause
    // we can't distinguish connection vs constraint failures.
    const cause = (err as { cause?: unknown }).cause;
    log.warn(
      {
        event: "notification_persist_failed",
        runId: input.runId,
        ownerId: input.ownerId,
        err: err instanceof Error ? err.message : String(err),
        cause:
          cause instanceof Error
            ? { message: cause.message, code: (cause as { code?: string }).code }
            : cause,
      },
      "failed to record notification",
    );
    return null;
  }
}
