import "server-only";

import {getEnabledVoiceCredential, type VoiceCredentialConfig} from "@/lib/credentials/lookup";
import {getUserVoiceSettings} from "@/lib/voice/user-voice-settings";
import {childLogger} from "@/lib/observability/logger";

const log = childLogger({component: "voice=tts"});

const OPENAI_TTS_VOICES = new Set([
    "alloy",
    "echo",
    "fable",
    "onyx",
    "nova",
    "shimmer"
]);

async function synthesizeOpenAI(
    config: VoiceCredentialConfig,
    text: string,
    voice: string,
    model: string | null,
): Promise<Response> {
    const baseUrl = config.host || "https://api.openai.com/v1";
    
    const res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: model || "tts-1",
            input: text,
            voice: voice,
            response_format: "mp3"
        }),
    });
    
    if (!res.ok) {
        const body = await res.text().catch(() => res.statusText);
        throw new Error(`OpenAI TTS failed: ${res.status} - ${body}`);
    }
    
    return res;
}


async function synthesizeElevenLabs(
    config: VoiceCredentialConfig,
    text: string,
    voiceId: string,
    model: string | null,
): Promise<Response> {
    // Fixed: baseUrl defaults to host without duplicate /v1
    const baseUrl = config.host || "https://api.elevenlabs.io";
    const res = await fetch(`${baseUrl}/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
            "xi-api-key": config.apiKey ?? "",
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
        },
        body: JSON.stringify({
            text: text,
            model_id: model || "eleven_flash_v2_5" // eleven_flash_v2_5 is standard low latency model in 2026
        }),
    });
    
    if (!res.ok) {
        const body = await res.text().catch(() => res.statusText);
        throw new Error(`ElevenLabs TTS failed: ${res.status} - ${body}`);
    }
    
    return res;
}


const OPENAI_DEFAULT_VOICE = "alloy";
const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

function resolveOpenAIVoice(userVoice: string | null): string {
    if (userVoice && OPENAI_TTS_VOICES.has(userVoice)) {
        return userVoice;
    }
    return OPENAI_DEFAULT_VOICE;
}

function resolveElevenLabsVoice(userVoice: string | null): string {
    return userVoice?.trim() || ELEVENLABS_DEFAULT_VOICE;
}

export async function synthesizeSpeech(text: string, userId: string): Promise<Response | null> {
    const settings = await getUserVoiceSettings(userId);
    if (!settings.ttsProvider) {
        return null;
    }
    const cred = await getEnabledVoiceCredential(settings.ttsProvider);
    if (!cred) {
        log.warn({ provider: settings.ttsProvider }, "No enabled credential found for user TTS provider");
        return null;
    }
    switch (cred.provider) {
        case "openai": // Merged voice provider
            return synthesizeOpenAI(cred, text, resolveOpenAIVoice(settings.ttsVoice), settings.ttsModel);
        case "elevenlabs":
            return synthesizeElevenLabs(cred, text, resolveElevenLabsVoice(settings.ttsVoice), settings.ttsModel);
        default:
            log.warn(`Unknown or unsupported TTS provider: ${cred.provider}`);
            return null;
    }
}

