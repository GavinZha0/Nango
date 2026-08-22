import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getTempMedia } from "@/lib/media/temp-media-cache";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const media = getTempMedia(id);

  if (!media) {
    return new NextResponse("Media not found", { status: 404 });
  }

  return new NextResponse(media.buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": media.mimeType,
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}
