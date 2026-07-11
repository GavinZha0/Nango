"use client";

import { useState, type ReactNode } from "react";
import { Volume2, Loader2 } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "ru", label: "Russian" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
];

const STT_ALL_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "deepgram", label: "Deepgram" },
  { value: "local-stt", label: "Local STT" },
];

const TTS_ALL_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "elevenlabs", label: "ElevenLabs" },
];

interface VoiceSettingsFieldProps {
  initialSttProvider: string | null;
  initialSttModel: string | null;
  initialSttLanguage: string | null;
  initialTtsProvider: string | null;
  initialTtsModel: string | null;
  initialTtsVoice: string | null;
  enabledProviders: string[];
}

export function VoiceSettingsField({
  initialSttProvider,
  initialSttModel,
  initialSttLanguage,
  initialTtsProvider,
  initialTtsModel,
  initialTtsVoice,
  enabledProviders = [],
}: VoiceSettingsFieldProps): ReactNode {
  // Saved reference states (updated upon successful save)
  const [refSttProvider, setRefSttProvider] = useState(initialSttProvider || "disabled");
  const [refSttModel, setRefSttModel] = useState(initialSttModel || "");
  const [refSttLanguage, setRefSttLanguage] = useState(initialSttLanguage || "auto");
  const [refTtsProvider, setRefTtsProvider] = useState(initialTtsProvider || "disabled");
  const [refTtsModel, setRefTtsModel] = useState(initialTtsModel || "");
  const [refTtsVoice, setRefTtsVoice] = useState(initialTtsVoice || "");

  // Editable form states
  const [sttProviderVal, setSttProviderVal] = useState(initialSttProvider || "disabled");
  const [sttModelVal, setSttModelVal] = useState(initialSttModel || "");
  const [sttLanguageVal, setSttLanguageVal] = useState(initialSttLanguage || "auto");
  const [ttsProviderVal, setTtsProviderVal] = useState(initialTtsProvider || "disabled");
  const [ttsModelVal, setTtsModelVal] = useState(initialTtsModel || "");
  const [ttsVoiceVal, setTtsVoiceVal] = useState(initialTtsVoice || "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = 
    sttProviderVal !== refSttProvider ||
    sttModelVal !== refSttModel ||
    sttLanguageVal !== refSttLanguage ||
    ttsProviderVal !== refTtsProvider ||
    ttsModelVal !== refTtsModel ||
    ttsVoiceVal !== refTtsVoice;

  const sttDisabled = sttProviderVal === "disabled";
  const ttsDisabled = ttsProviderVal === "disabled";

  // Filter providers to only display enabled ones, or preserve currently saved provider
  const sttProviders = [
    { value: "disabled", label: "Disabled" },
    ...STT_ALL_PROVIDERS.filter(
      (p) => p.value === initialSttProvider || enabledProviders.includes(p.value)
    ),
  ];

  const ttsProviders = [
    { value: "disabled", label: "Disabled" },
    ...TTS_ALL_PROVIDERS.filter(
      (p) => p.value === initialTtsProvider || enabledProviders.includes(p.value)
    ),
  ];

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    
    const updates = {
      sttProvider: sttProviderVal === "disabled" ? null : sttProviderVal,
      sttModel: sttModelVal.trim() || null,
      sttLanguage: sttLanguageVal === "auto" ? null : sttLanguageVal,
      ttsProvider: ttsProviderVal === "disabled" ? null : ttsProviderVal,
      ttsModel: ttsModelVal.trim() || null,
      ttsVoice: ttsVoiceVal.trim() || null,
    };
    
    const res = await authClient
      .updateUser(updates)
      .catch((err: unknown) => ({
        error: { message: err instanceof Error ? err.message : String(err) },
      }));
    
    setSaving(false);
    
    if (res && "error" in res && res.error) {
      setError("Failed to save voice settings.");
      return;
    }

    // Commit local references to clear dirty status
    setRefSttProvider(sttProviderVal);
    setRefSttModel(sttModelVal);
    setRefSttLanguage(sttLanguageVal);
    setRefTtsProvider(ttsProviderVal);
    setRefTtsModel(ttsModelVal);
    setRefTtsVoice(ttsVoiceVal);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Volume2 className="h-4 w-4 text-primary" />
          </div>
          <CardTitle className="text-base">Voice Settings</CardTitle>
        </div>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={handleSave}
          className="h-8 px-3 text-xs"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* --- STT Section --- */}
        <div className="space-y-3">
          <div className="space-y-2">
            {/* Row 1: STT Provider */}
            <div className="flex items-center gap-4 w-full min-h-8">
              <Label htmlFor="stt-provider-select" className="text-xs font-medium text-foreground w-20 shrink-0">
                STT Provider
              </Label>
              <div className="flex-1 flex items-center">
                <Select
                  value={sttProviderVal}
                  onValueChange={(v) => setSttProviderVal(v ?? "disabled")}
                  disabled={saving}
                >
                  <SelectTrigger id="stt-provider-select" className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sttProviders.map((p) => (
                      <SelectItem key={p.value} value={p.value} className="text-xs">
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Row 2: STT Model */}
            <div className="flex items-center gap-4 w-full min-h-8">
              <Label 
                htmlFor="stt-model-input" 
                className={`text-xs font-medium w-20 shrink-0 ${sttDisabled ? "text-muted-foreground/50" : "text-foreground"}`}
              >
                STT Model
              </Label>
              <div className="flex-1 flex items-center">
                <Input
                  id="stt-model-input"
                  value={sttModelVal}
                  onChange={(e) => setSttModelVal(e.target.value)}
                  placeholder={sttProviderVal === "openai" ? "whisper-1" : sttProviderVal === "deepgram" ? "nova-3" : "base"}
                  disabled={sttDisabled || saving}
                  className="w-full h-8 text-xs"
                />
              </div>
            </div>

            {/* Row 3: STT Language */}
            <div className="flex items-center gap-4 w-full min-h-8">
              <Label 
                htmlFor="stt-language-select" 
                className={`text-xs font-medium w-20 shrink-0 ${sttDisabled ? "text-muted-foreground/50" : "text-foreground"}`}
              >
                STT Language
              </Label>
              <div className="flex-1 flex items-center">
                <Select
                  value={sttLanguageVal}
                  onValueChange={(v) => setSttLanguageVal(v ?? "auto")}
                  disabled={sttDisabled || saving}
                >
                  <SelectTrigger id="stt-language-select" className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_OPTIONS.map((lang) => (
                      <SelectItem key={lang.value} value={lang.value} className="text-xs">
                        {lang.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>

        {/* --- TTS Section --- */}
        <div className="space-y-3 pt-4 border-t border-border/40">
          <div className="space-y-2">
            {/* Row 4: TTS Provider */}
            <div className="flex items-center gap-4 w-full min-h-8">
              <Label htmlFor="tts-provider-select" className="text-xs font-medium text-foreground w-20 shrink-0">
                TTS Provider
              </Label>
              <div className="flex-1 flex items-center">
                <Select
                  value={ttsProviderVal}
                  onValueChange={(v) => setTtsProviderVal(v ?? "disabled")}
                  disabled={saving}
                >
                  <SelectTrigger id="tts-provider-select" className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ttsProviders.map((p) => (
                      <SelectItem key={p.value} value={p.value} className="text-xs">
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Row 5: TTS Model */}
            <div className="flex items-center gap-4 w-full min-h-8">
              <Label 
                htmlFor="tts-model-input" 
                className={`text-xs font-medium w-20 shrink-0 ${ttsDisabled ? "text-muted-foreground/50" : "text-foreground"}`}
              >
                TTS Model
              </Label>
              <div className="flex-1 flex items-center">
                <Input
                  id="tts-model-input"
                  value={ttsModelVal}
                  onChange={(e) => setTtsModelVal(e.target.value)}
                  placeholder={ttsProviderVal === "openai" ? "tts-1" : "eleven_flash_v2_5"}
                  disabled={ttsDisabled || saving}
                  className="w-full h-8 text-xs"
                />
              </div>
            </div>

            {/* Row 6: TTS Voice */}
            <div className="flex items-center gap-4 w-full min-h-8">
              <Label 
                htmlFor="tts-voice-input" 
                className={`text-xs font-medium w-20 shrink-0 ${ttsDisabled ? "text-muted-foreground/50" : "text-foreground"}`}
              >
                TTS Voice
              </Label>
              <div className="flex-1 flex items-center">
                <Input
                  id="tts-voice-input"
                  value={ttsVoiceVal}
                  onChange={(e) => setTtsVoiceVal(e.target.value)}
                  placeholder={ttsProviderVal === "openai" ? "alloy" : "Voice ID"}
                  disabled={ttsDisabled || saving}
                  className="w-full h-8 text-xs"
                />
              </div>
            </div>
          </div>
        </div>

        {error && (
          <p className="text-xs text-destructive pt-2">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
