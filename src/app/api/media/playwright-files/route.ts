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

  const searchDir = resolvePlaywrightOutputDir();
  if (!searchDir) {
    return NextResponse.json(
      {
        error: "ROOT_NOT_CONFIGURED",
        file,
        message:
          "Playwright screenshot storage is unavailable because `host.file.root` is not configured in Admin → Config.",
      },
      { status: 404 },
    );
  }

  const result = await readPlaywrightScreenshot(file);

  if (!result) {
    return NextResponse.json(
      {
        error: "FILE_NOT_FOUND",
        file,
        searchDir,
        message: `Screenshot file not found under "${searchDir}". Verify \`host.file.root\` and Playwright MCP's output directory.`,
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
