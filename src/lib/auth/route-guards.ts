import "server-only";

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/auth-instance";
import {
  AUTHENTICATED_HOME_PATH,
  UNAUTHENTICATED_REDIRECT_PATH,
} from "@/lib/auth/access-rules";

export async function requireSession(): Promise<void> {
  const session = await getSession();

  if (!session) {
    redirect(UNAUTHENTICATED_REDIRECT_PATH);
  }
}

export async function redirectIfAuthenticated(): Promise<void> {
  const session = await getSession();

  if (session) {
    redirect(AUTHENTICATED_HOME_PATH);
  }
}

export async function requireEditor(): Promise<void> {
  const session = await getSession();

  if (!session) {
    redirect(UNAUTHENTICATED_REDIRECT_PATH);
  }

  const role = session.user.role;
  if (role !== "admin" && role !== "editor") {
    redirect(AUTHENTICATED_HOME_PATH);
  }
}

export async function requireAdmin(): Promise<void> {
  const session = await getSession();

  if (!session) {
    redirect(UNAUTHENTICATED_REDIRECT_PATH);
  }

  if (session.user.role !== "admin") {
    redirect(AUTHENTICATED_HOME_PATH);
  }
}
