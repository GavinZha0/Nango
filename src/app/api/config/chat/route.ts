/**
 * GET /api/config/chat — session-scoped read of chat composer attachment limits.
 */

import "server-only";

import { NextResponse } from "next/server";

import { getConfigNumber } from "@/lib/config";
import { withSession } from "@/lib/http/route-handlers";
import {
  CHAT_ATTACHMENT_IMAGE_MAX_BYTES_KEY,
  CHAT_ATTACHMENT_TEXT_MAX_BYTES_KEY,
  DEFAULT_CHAT_ATTACHMENT_IMAGE_MAX_BYTES,
  DEFAULT_CHAT_ATTACHMENT_TEXT_MAX_BYTES,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/chat/attachments";

const ROUTE = "/api/config/chat";

export const GET = withSession(ROUTE, async () => {
  const imageMaxBytes = Math.max(
    1024,
    getConfigNumber(
      CHAT_ATTACHMENT_IMAGE_MAX_BYTES_KEY,
      DEFAULT_CHAT_ATTACHMENT_IMAGE_MAX_BYTES,
    ),
  );
  const textMaxBytes = Math.max(
    1024,
    getConfigNumber(
      CHAT_ATTACHMENT_TEXT_MAX_BYTES_KEY,
      DEFAULT_CHAT_ATTACHMENT_TEXT_MAX_BYTES,
    ),
  );

  return NextResponse.json({
    imageMaxBytes,
    textMaxBytes,
    maxAttachmentsPerMessage: MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  });
});
