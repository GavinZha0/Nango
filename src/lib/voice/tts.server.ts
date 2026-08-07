import "server-only";

import {getEnabledVoiceCredentialById, type VoiceCredentialConfig} from "@/lib/credentials/lookup";
import {getUserVoiceSettings} from "@/lib/voice/user-voice-settings";
import {childLogger} from "@/lib/observability/logger";

const log = childLogger({component: "voice=tts"});


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

const OPENAI_DEFAULT_VOICE = "alloy";

function resolveOpenAIVoice(userVoice: string | null): string {
    return userVoice?.trim() || OPENAI_DEFAULT_VOICE;
}

export async function synthesizeSpeech(text: string, userId: string): Promise<Response | null> {
    const settings = await getUserVoiceSettings(userId);
    if (!settings.ttsCredentialId) {
        return null;
    }
    const cred = await getEnabledVoiceCredentialById(settings.ttsCredentialId);
    if (!cred) {
        log.warn({ credentialId: settings.ttsCredentialId }, "No enabled credential found for user TTS credential");
        return null;
    }
    switch (cred.provider) {
        case "openai":
        case "edge-tts":
        case "kokoro":
            return synthesizeOpenAI(cred, text, resolveOpenAIVoice(settings.ttsVoice), settings.ttsModel);
        default:
            log.warn(`Unknown or unsupported TTS provider: ${cred.provider}`);
            return null;
    }
}

