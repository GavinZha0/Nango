import type { ReactNode } from "react";
import { AuthForm } from "@/components/auth/auth-form";

export default function SignUpPage(): ReactNode {
  return <AuthForm mode="sign-up" />;
}
