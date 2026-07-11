import { NextResponse } from "next/server";
import { z } from "zod";
import { withSession, ApiError } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { synthesizeSpeech } from "@/lib/voice/tts.server";

export const dynamic = "force-dynamic";

const ROUTE = "/api/tts";

const bodySchema = z.object({
    text: z.string().min(1).max(5000),
});


export const POST = withSession(ROUTE, async ({req, session}) => {
    const { text } = await parseBody(req, bodySchema);

    try {
        const upstream = await synthesizeSpeech(text, session.user.id);
        if (!upstream) {
            return NextResponse.json({ error: "No TTS service configured." }, { status: 503 });
        }

        return new Response(upstream.body, {
            status: 200,
            headers: {
                "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
                "Cache-Control": "no-store",
            },
        });
    } catch (err) {
        throw new ApiError(
            "BAD_GATEWAY",
            502,
            err instanceof Error ? err.message : String(err)
        );
    }
});
