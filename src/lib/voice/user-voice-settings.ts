import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { UserTable } from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "user-voice-settings" });

export interface UserVoiceSettings {
    sttCredentialId: string | null;
    sttModel: string | null;
    sttLanguage: string | null;
    ttsCredentialId: string | null;
    ttsModel: string | null;
    ttsVoice: string | null;
}


const EMPTY: UserVoiceSettings = {
    sttCredentialId: null,
    sttModel: null,
    sttLanguage: null,
    ttsCredentialId: null,
    ttsModel: null,
    ttsVoice: null,
};



export async function getUserVoiceSettings(userId: string | undefined): Promise<UserVoiceSettings> {
    if (!userId) {
        return EMPTY;
    }

    try {
        const [row] = await db.select({
            sttCredentialId: UserTable.sttCredentialId,
            sttModel: UserTable.sttModel,
            sttLanguage: UserTable.sttLanguage,
            ttsCredentialId: UserTable.ttsCredentialId,
            ttsModel: UserTable.ttsModel,
            ttsVoice: UserTable.ttsVoice,
        }).from(UserTable).where(eq(UserTable.id, userId)).limit(1);
        if (!row) {
            return EMPTY;
        }
        return {
            sttCredentialId: row.sttCredentialId,
            sttModel: row.sttModel,
            sttLanguage: row.sttLanguage,
            ttsCredentialId: row.ttsCredentialId,
            ttsModel: row.ttsModel,
            ttsVoice: row.ttsVoice,
        };
    } catch (error) {
        log.error({ error }, "Failed to get user voice settings");
        return EMPTY;
    }
}

