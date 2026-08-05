import "server-only";

import { TranscriptionService, type TranscribeFileOptions } from "@/lib/copilot/index.server";
import { getEnabledVoiceCredentialById, type VoiceCredentialConfig } from "@/lib/credentials/lookup";
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

class FunASRTranscriptionService extends TranscriptionService {
    constructor(
        private config: VoiceCredentialConfig,
        private language: string | null,
        private model: string | null,
    ) {
        super();
    }

    async transcribeFile({ audioFile }: TranscribeFileOptions): Promise<string> {
        if (!this.config.host) {
            throw new Error("funasr: host is required (e.g. ws://localhost:10095)");
        }

        const buffer = await audioFile.arrayBuffer();
        // Assuming the browser sends a 16kHz 16-bit mono WAV.
        // We strip the 44-byte WAV header to get raw PCM.
        const pcmBuffer = buffer.byteLength > 44 ? buffer.slice(44) : buffer;

        return new Promise((resolve, reject) => {
            const wsUrl = new URL(this.config.host!.replace(/^http/, "ws"));
            if (this.config.apiKey) {
                wsUrl.searchParams.append("token", this.config.apiKey);
            }
            const ws = new WebSocket(wsUrl.toString());
            let fullText = "";
            
            // Timeout to prevent hanging
            const timeoutId = setTimeout(() => {
                ws.close();
                reject(new Error("FunASR timeout (60s)"));
            }, 60000);

            ws.onopen = () => {
                ws.send(JSON.stringify({
                    mode: 'offline',
                    chunk_size: [5, 10, 5],
                    wav_name: 'microphone',
                    is_speaking: true,
                    chunk_interval: 10,
                    itn: true
                }));
                ws.send(pcmBuffer);
                ws.send(JSON.stringify({ is_speaking: false }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data.toString());
                    if (data.text) {
                        fullText += data.text;
                    }
                    if (data.is_final) {
                        clearTimeout(timeoutId);
                        ws.close();
                        resolve(fullText);
                    }
                } catch (err) {
                    log.error({ err, data: event.data.toString() }, "FunASR JSON parse error");
                }
            };

            ws.onerror = (e) => {
                log.error({ e }, "FunASR WebSocket error");
                clearTimeout(timeoutId);
                reject(new Error("FunASR WebSocket error"));
            };
            
            ws.onclose = () => {
                clearTimeout(timeoutId);
                resolve(fullText);
            };
        });
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

class SenseVoiceFastAPITranscriptionService extends TranscriptionService {
    constructor(
        private config: VoiceCredentialConfig,
        private language: string | null,
        private model: string | null,
    ) {
        super();
    }

    async transcribeFile({ audioFile }: TranscribeFileOptions): Promise<string> {
        if (!this.config.host) {
            throw new Error("SenseVoice: host is required");
        }

        const form = new FormData();
        form.append("file", audioFile);
        if (this.language && this.language !== "auto") {
            form.append("language", this.language);
        }

        const headers: Record<string, string> = {};
        if (this.config.apiKey) {
            headers["x-api-key"] = this.config.apiKey;
        }

        // Support both /asr (lightweight images) and standard fastapi endpoints
        // If the user already provided a full path in host, we just append /asr if missing
        const url = this.config.host.endsWith("/asr") ? this.config.host : `${this.config.host.replace(/\/$/, '')}/asr`;

        const res = await fetch(url, {
            method: "POST",
            headers,
            body: form,
        });

        if (!res.ok) {
            const errorText = await res.text().catch(() => res.statusText);
            log.error({ error: errorText }, "SenseVoice FastAPI transcription failed");
            throw new Error(`SenseVoice FastAPI failed: ${errorText}`);
        }

        const data = await res.json() as { text?: string; result?: string };
        const text = data.text !== undefined ? data.text : data.result;
        if (text === undefined) {
            throw new Error(`SenseVoice returned invalid format: ${JSON.stringify(data)}`);
        }
        
        // SenseVoice often returns raw model tags like <|zh|><|NEUTRAL|><|Speech|> before the text
        // We strip these out. Also, if the transcription is empty (e.g. noise), return empty string.
        const cleanedText = text.replace(/<\|.*?\|>/g, '').trim();
        return cleanedText;
    }
}

function createTranscriptionService(
    config: VoiceCredentialConfig,
    language: string | null,
    model: string | null,
): TranscriptionService {
    switch (config.provider) {
        case "funasr":
            return new FunASRTranscriptionService(config, language, model);
        case "deepgram":
            return new DeepgramTranscriptionService(config, language, model);
        case "openai": // Merged voice provider
            return new WhisperTranscriptionService(config, language, model);
        case "sensevoice": // Specifically for markgzhou/sensevoice-asr-server or similar lightweight FastAPI wrappers
            return new SenseVoiceFastAPITranscriptionService(config, language, model);
        default:
            log.warn({ provider: config.provider }, "Unsupported transcription provider");
            throw new Error(`Unsupported transcription provider: ${config.provider}`);
    }
}

export async function resolveTranscriptionService(userId: string): Promise<TranscriptionService | undefined> {
    const settings = await getUserVoiceSettings(userId);
    if (!settings.sttCredentialId) {
        // Microphone will be hidden automatically when this returns undefined
        return undefined;
    }
    const cred = await getEnabledVoiceCredentialById(settings.sttCredentialId);
    if (!cred) {
        log.warn({ credentialId: settings.sttCredentialId }, "No enabled credential found for user STT credential");
        return undefined;
    }
    log.info({ provider: cred.provider, model: settings.sttModel, language: settings.sttLanguage }, "STT transcription service resolved");
    return createTranscriptionService(cred, settings.sttLanguage, settings.sttModel);
}
