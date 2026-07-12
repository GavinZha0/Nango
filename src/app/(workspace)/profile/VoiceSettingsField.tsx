"use client";

import { useMemo, useState, type ReactNode } from "react";
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

const DISABLED = "disabled";
type CredOption = { value: string; label: string, provider: string };
type SelectItem = { value: string; label: string };

interface VoiceSettingsFieldProps {
  initialSttCredentialId: string | null;
  initialSttModel: string | null;
  initialSttLanguage: string | null;
  initialTtsCredentialId: string | null;
  initialTtsModel: string | null;
  initialTtsVoice: string | null;
  sttCredentials: CredOption[];
  ttsCredentials: CredOption[];
}

function buildSelect(credentials: CredOption[], savedId: string | null): {
  providerById: Map<string, string>;
  options: SelectItem[];
  items: SelectItem[];
} {
  const providerById = new Map(credentials.map((c) => [c.value, c.provider]));
  const options: SelectItem[] = [{ value: DISABLED, label: "Disabled" }, ...credentials.map((c) => ({ value: c.value, label: c.label }))];
  const items = [...options];
  if (savedId && !providerById.has(savedId)) {
    items.push({ value: savedId, label: "Unknown" });
  }
  return { providerById, options, items };
}

export function VoiceSettingsField({
  initialSttCredentialId,
  initialSttModel,
  initialSttLanguage,
  initialTtsCredentialId,
  initialTtsModel,
  initialTtsVoice,
  sttCredentials = [],
  ttsCredentials = [],
}: VoiceSettingsFieldProps): ReactNode {
  // Saved reference states (updated upon successful save)
  const [refSttCredentialId, setRefSttCredentialId] = useState(initialSttCredentialId || DISABLED);
  const [refSttModel, setRefSttModel] = useState(initialSttModel || "");
  const [refSttLanguage, setRefSttLanguage] = useState(initialSttLanguage || "auto");
  const [refTtsCredentialId, setRefTtsCredentialId] = useState(initialTtsCredentialId || DISABLED);
  const [refTtsModel, setRefTtsModel] = useState(initialTtsModel || "");
  const [refTtsVoice, setRefTtsVoice] = useState(initialTtsVoice || "");

  // Editable form states
  const [sttCredentialVal, setSttCredentialVal] = useState(initialSttCredentialId || DISABLED);
  const [sttModelVal, setSttModelVal] = useState(initialSttModel || "");
  const [sttLanguageVal, setSttLanguageVal] = useState(initialSttLanguage || "auto");
  const [ttsCredentialVal, setTtsCredentialVal] = useState(initialTtsCredentialId || DISABLED);
  const [ttsModelVal, setTtsModelVal] = useState(initialTtsModel || "");
  const [ttsVoiceVal, setTtsVoiceVal] = useState(initialTtsVoice || "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stt = useMemo(() => buildSelect(sttCredentials, initialSttCredentialId), [sttCredentials, initialSttCredentialId]);
  const tts = useMemo(() => buildSelect(ttsCredentials, initialTtsCredentialId), [ttsCredentials, initialTtsCredentialId]);

  const dirty = 
    sttCredentialVal !== refSttCredentialId ||
    sttModelVal !== refSttModel ||
    sttLanguageVal !== refSttLanguage ||
    ttsCredentialVal !== refTtsCredentialId ||
    ttsModelVal !== refTtsModel ||
    ttsVoiceVal !== refTtsVoice;

  const sttDisabled = sttCredentialVal === DISABLED;
  const ttsDisabled = ttsCredentialVal === DISABLED;

  const sttProvider = stt.providerById.get(sttCredentialVal) ?? "";
  const ttsProvider = tts.providerById.get(ttsCredentialVal) ?? "";

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    
    const updates = {
      sttCredentialId: sttCredentialVal === DISABLED ? null : sttCredentialVal,
      sttModel: sttModelVal.trim() || null,
      sttLanguage: sttLanguageVal === "auto" ? null : sttLanguageVal,
      ttsCredentialId: ttsCredentialVal === DISABLED ? null : ttsCredentialVal,
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
    setRefSttCredentialId(sttCredentialVal);
    setRefSttModel(sttModelVal);
    setRefSttLanguage(sttLanguageVal);
    setRefTtsCredentialId(ttsCredentialVal);
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
                items={stt.items}
                  value={sttCredentialVal}
                  onValueChange={(v) => setSttCredentialVal(v ?? DISABLED)}
                  disabled={saving}
                >
                  <SelectTrigger id="stt-provider-select" className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {stt.options.map((p) => (
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
                  placeholder={sttProvider === "openai" ? "whisper-1" : sttProvider === "deepgram" ? "nova-3" : "base"}
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
                  items={LANGUAGE_OPTIONS}
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
                  items={tts.options}
                  value={ttsCredentialVal}
                  onValueChange={(v) => setTtsCredentialVal(v ?? DISABLED)}
                  disabled={saving}
                >
                  <SelectTrigger id="tts-provider-select" className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tts.options.map((p) => (
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
                  placeholder={ttsProvider === "openai" ? "tts-1" : "eleven_flash_v2_5"}
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
                  placeholder={ttsProvider === "openai" ? "alloy" : "Voice ID"}
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
