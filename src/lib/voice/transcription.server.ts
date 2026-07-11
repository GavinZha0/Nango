import "server-only";

import { TranscriptionService, type TranscribeFileOptions } from "@/lib/copilot/index.server";
import { getEnabledVoiceCredential, type VoiceCredentialConfig } from "@/lib/credentials/lookup";
import { getUserVoiceSettings } from "@/lib/voice/user-voice-settings";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "voice=stt" });

class WhisperTranscriptionService extends TranscriptionService {
    constructor(
        private config: VoiceCredentialConfig,
        private language: string | null,
        private model: string | null,
    ) {
        super();
    }

    async transcribeFile({ audioFile }: TranscribeFileOptions): Promise<string> {
        const baseUrl = this.config.host || "https://api.openai.com/v1";
        const form = new FormData();
        form.append("file", audioFile);
        form.append("model", this.model || "whisper-1");
        if (this.language) {
            form.append("language", this.language);
        }

        const res = await fetch(`${baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.config.apiKey}`,
            },
            body: form,
        });
        if (!res.ok) {
            const errorText = await res.text().catch(() => res.statusText);
            log.error({ error: errorText }, "Whisper transcription failed");
            throw new Error(`Whisper transcription failed: ${errorText}`);
        }
        const data = await res.json() as { text: string };
        return data.text;
    }
}

class LocalTranscriptionService extends TranscriptionService {
    constructor(
        private config: VoiceCredentialConfig,
        private language: string | null,
        private model: string | null,
    ) {
        super();
    }

    async transcribeFile({ audioFile }: TranscribeFileOptions): Promise<string> {
        if (!this.config.host) {
            throw new Error("Local-stt: restUrl is required");
        }

        const form = new FormData();
        form.append("file", audioFile);
        form.append("model", this.model || "base");
        if(this.language) {
            form.append("language", this.language);
        }
        const headers: Record<string, string> = {};
        if (this.config.apiKey) {
            headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }
        const res = await fetch(`${this.config.host}/v1/audio/transcribe`, {
            method: "POST",
            headers,
            body: form,
        });
        if (!res.ok) {
            const errorText = await res.text().catch(() => res.statusText);
            log.error({ error: errorText }, "Local transcription failed");
            throw new Error(`Local transcription failed: ${errorText}`);
        }
        const data = await res.json() as { text: string };
        return data.text;
    }
}

class DeepgramTranscriptionService extends TranscriptionService {
    constructor(
        private config: VoiceCredentialConfig,
        private language: string | null,
        private model: string | null,
    ) {
        super();
    }

    async transcribeFile({ audioFile }: TranscribeFileOptions): Promise<string> {
        const baseUrl = this.config.host || "https://api.deepgram.com";
        const buffer = await audioFile.arrayBuffer();
        const langParam = this.language ? `&language=${this.language}` : "";
        const modelName = this.model || "nova-3"; // Default to nova-3 in 2026

        // Fixed: Added /v1 path segment to Deepgram REST endpoint
        const res = await fetch(`${baseUrl}/v1/listen?model=${modelName}${langParam}`, {
            method: "POST",
            headers: {
                "Authorization": `Token ${this.config.apiKey}`,
                "Content-Type": "audio/webm"
            },
            body: buffer,
        });
        if (!res.ok) {
            const errorText = await res.text().catch(() => res.statusText);
            log.error({ error: errorText }, "Deepgram transcription failed");
            throw new Error(`Deepgram transcription failed: ${errorText}`);
        }
        const data = await res.json() as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
        const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        if (!transcript) {
            throw new Error("Deepgram returned empty transcript");
        }
        return transcript;
    }
}

function createTranscriptionService(
    config: VoiceCredentialConfig,
    language: string | null,
    model: string | null,
): TranscriptionService {
    switch (config.provider) {
        case "local-stt":
            return new LocalTranscriptionService(config, language, model);
        case "deepgram":
            return new DeepgramTranscriptionService(config, language, model);
        case "openai": // Merged voice provider
            return new WhisperTranscriptionService(config, language, model);
        default:
            log.warn({ provider: config.provider }, "Unsupported transcription provider");
            throw new Error(`Unsupported transcription provider: ${config.provider}`);
    }
}

export async function resolveTranscriptionService(userId: string): Promise<TranscriptionService | undefined> {
    const settings = await getUserVoiceSettings(userId);
    if (!settings.sttProvider) {
        // Microphone will be hidden automatically when this returns undefined
        return undefined;
    }
    const cred = await getEnabledVoiceCredential(settings.sttProvider);
    if (!cred) {
        log.warn({ provider: settings.sttProvider }, "No enabled credential found for user STT provider");
        return undefined;
    }
    log.info({ provider: cred.provider, model: settings.sttModel, language: settings.sttLanguage }, "STT transcription service resolved");
    return createTranscriptionService(cred, settings.sttLanguage, settings.sttModel);
}