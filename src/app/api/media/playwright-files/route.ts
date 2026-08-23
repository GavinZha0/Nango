import "server-only";

import { NextRequest, NextResponse } from "next/server";
import {
  readPlaywrightScreenshot,
  resolvePlaywrightOutputDir,
} from "@/lib/playwright/storage.server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const file = req.nextUrl.searchParams.get("file");

  if (!file || file.trim().length === 0) {
    return NextResponse.json(
      {
        error: "MISSING_PARAM",
        message: "Query parameter 'file' is required.",
      },
      { status: 400 },
    );
  }

  const result = await readPlaywrightScreenshot(file);

  if (!result) {
    return NextResponse.json(
      {
        error: "FILE_NOT_FOUND",
        file,
        searchDir: resolvePlaywrightOutputDir(),
        message:
          "Screenshot file not found on disk. Please verify that '.cache/playwright' is mounted in docker-compose.yaml.",
      },
      { status: 404 },
    );
  }

  return new NextResponse(result.buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": result.mimeType,
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Disposition": `inline; filename="${result.filename}"`,
    },
  });
}
