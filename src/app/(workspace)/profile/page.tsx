import { getSession } from "@/lib/auth/auth-instance";
import { db } from "@/lib/db";
import { CredentialTable } from "@/lib/db/schema";
import { getProviderCapability } from "@/lib/constants/providers";
import { and, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
import { BasicInfoField } from "./BasicInfoField";
import { PasswordField } from "./PasswordField";
import { VoiceSettingsField } from "./VoiceSettingsField";
import { StatsDashboard } from "./StatsDashboard";
import { ScrollArea } from "@/components/ui/scroll-area";

function formatRole(role: string | null | undefined): string {
  if (!role) {
    return "user";
  }
  return role;
}

export default async function ProfilePage(): Promise<React.ReactNode> {
  const session = await getSession();
  const enabledVoiceCreds = await db
    .select({
      id: CredentialTable.id,
      provider: CredentialTable.provider,
      name: CredentialTable.name,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.serviceType, "voice"),
        eq(CredentialTable.enabled, true),
      )
    ).orderBy(desc(CredentialTable.createdAt));
  
  type VoiceCredentialOption = {value: string, label: string, provider: string};
  const sttCredentials: VoiceCredentialOption[] = [];
  const ttsCredentials: VoiceCredentialOption[] = [];
  for (const cred of enabledVoiceCreds) {
    const option = {
      value: cred.id,
      label: cred.name,
      provider: cred.provider ?? "",
    };
    const capability = getProviderCapability(option.provider) ?? [];
    if (capability.includes("stt")) {
      sttCredentials.push(option);
    }
    if (capability.includes("tts")) {
      ttsCredentials.push(option);
    }
  }
  
  const userName: string = session?.user?.name ?? "Unknown";
  const userEmail: string = session?.user?.email ?? "";
  const userRole: string = formatRole(session?.user?.role);
  // better-auth additionalFields are present at runtime but TS doesn't
  // narrow the session type to include them here; cast locally.
  const userFields = session?.user as
    | { 
        timezone?: string | null; 
        timezoneFollowBrowser?: boolean | null; 
        sttLanguage?: string | null; 
        sttCredentialId?: string | null;
        sttModel?: string | null;
        ttsVoice?: string | null; 
        ttsCredentialId?: string | null;
        ttsModel?: string | null;
      }
    | undefined;
  const userTimezone: string | null = userFields?.timezone ?? null;
  const userFollowBrowser: boolean = userFields?.timezoneFollowBrowser ?? true;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-6 md:p-8">
        {/* Page heading */}
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        </div>

        {/* Three-column: Basic Info | Password | Voice Settings */}
        <div className="grid items-start gap-6 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          <BasicInfoField
            userName={userName}
            userEmail={userEmail}
            userRole={userRole}
            initialTimezone={userTimezone}
            initialFollowBrowser={userFollowBrowser}
          />

          <PasswordField />

          <VoiceSettingsField 
            initialSttCredentialId={userFields?.sttCredentialId ?? null}
            initialSttModel={userFields?.sttModel ?? null}
            initialSttLanguage={userFields?.sttLanguage ?? null} 
            initialTtsCredentialId={userFields?.ttsCredentialId ?? null}
            initialTtsModel={userFields?.ttsModel ?? null}
            initialTtsVoice={userFields?.ttsVoice ?? null} 
            sttCredentials={sttCredentials}
            ttsCredentials={ttsCredentials}
          />
        </div>

        {/* Divider */}
        <hr className="border-border" />

        {/* Resource stats */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Resource usage (last 30 days)</h2>
          <StatsDashboard />
        </div>
      </div>
    </ScrollArea>
  );
}
