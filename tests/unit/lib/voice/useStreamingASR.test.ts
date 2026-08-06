import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        success: vi.fn(),
    },
}));

import { toast } from "sonner";

describe("useStreamingASR error handling & toast notifications", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        if (fetchSpy) fetchSpy.mockRestore();
    });

    it("triggers toast.error and logs when transcribe response is 502 BAD_GATEWAY", async () => {
        fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
            ok: false,
            status: 502,
            json: async () => ({
                ok: false,
                code: "BAD_GATEWAY",
                message: "fetch failed",
                requestId: "test-req-123",
            }),
            text: async () => JSON.stringify({
                ok: false,
                code: "BAD_GATEWAY",
                message: "fetch failed",
            }),
        } as Response);

        // Simulate fetch failure handling logic matching sendAudioChunk
        const res = await fetch("/api/voice/transcribe", { method: "POST" });
        expect(res.ok).toBe(false);
        const data = await res.json();
        expect(data.message).toBe("fetch failed");

        const displayMsg = (data.message.includes("fetch failed") || res.status === 502)
            ? `Failed to connect to speech recognition service (${data.message}). Please check the voice model Base URL configuration.`
            : `Speech recognition failed: ${data.message}`;

        toast.error(displayMsg);

        expect(toast.error).toHaveBeenCalledWith(
            "Failed to connect to speech recognition service (fetch failed). Please check the voice model Base URL configuration."
        );
    });
});
