import { NextResponse } from "next/server";
import { withSession, ApiError } from "@/lib/http/route-handlers";
import { resolveTranscriptionService } from "@/lib/voice/transcription.server";

export const dynamic = "force-dynamic";

const ROUTE = "/api/voice/transcribe";

// Simple in-memory rate limiter: Max 50 requests per minute per user
const rateLimitMap = new Map<string, { count: number, timestamp: number }>();

export const POST = withSession(ROUTE, async ({req, session}) => {
    const now = Date.now();
    const rateLimit = rateLimitMap.get(session.user.id);
    if (!rateLimit || (now - rateLimit.timestamp > 60000)) {
        rateLimitMap.set(session.user.id, { count: 1, timestamp: now });
    } else {
        if (rateLimit.count > 50) {
            throw new ApiError("TOO_MANY_REQUESTS", 429, "Too many transcription requests. Please wait a moment.");
        }
        rateLimit.count++;
    }

    const formData = await req.formData().catch(() => null);
    if (!formData) {
        throw new ApiError("BAD_REQUEST", 400, "Invalid form data");
    }

    const file = formData.get("file") as File | null;
    
    if (!file) {
        throw new ApiError("BAD_REQUEST", 400, "Missing audio file in form data");
    }

    // Limit to 25MB (OpenAI standard) to prevent memory exhaustion
    if (file.size > 25 * 1024 * 1024) {
        throw new ApiError("BAD_REQUEST", 400, "Audio file is too large (max 25MB).");
    }

    // Resolve the appropriate adapter based on the user's credential (provider/host)
    const transcriptionService = await resolveTranscriptionService(session.user.id);

    if (!transcriptionService) {
        throw new ApiError("UNAUTHENTICATED", 401, "No valid STT credential found.");
    }

    try {
        const text = await transcriptionService.transcribeFile({ audioFile: file });
        return NextResponse.json({ text });
    } catch (err) {
        throw new ApiError(
            "BAD_GATEWAY",
            502,
            err instanceof Error ? err.message : String(err)
        );
    }
});
