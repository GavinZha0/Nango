import type { ReactNode } from "react";
import { AuthForm } from "@/components/auth/auth-form";

export default function SignInPage(): ReactNode {
  return <AuthForm mode="sign-in" />;
}
