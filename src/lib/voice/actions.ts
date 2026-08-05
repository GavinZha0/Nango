"use server";

import { auth } from "@/lib/auth/auth-instance";
import { headers } from "next/headers";
import { getEnabledVoiceCredentialById } from "@/lib/credentials/lookup";

export async function getVoiceCredentialBaseUrl(credentialId: string): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session?.user) return null;

  const cred = await getEnabledVoiceCredentialById(credentialId);
  if (!cred) return null;

  return cred.host;
}
