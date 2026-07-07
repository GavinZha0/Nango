"use client";

import { useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AuthMode = "sign-in" | "sign-up";

interface AuthFormValues {
  name: string;
  email: string;
  password: string;
}

interface AuthContent {
  title: string;
  description: string;
  submitLabel: string;
  submittingLabel: string;
  errorFallback: string;
  alternateText: string;
  alternateHref: string;
  alternateAction: string;
}

export interface AuthFormProps {
  mode: AuthMode;
}

const INITIAL_FORM_VALUES: AuthFormValues = {
  name: "",
  email: "",
  password: "",
};

const AUTH_CONTENT: Record<AuthMode, AuthContent> = {
  "sign-in": {
    title: "Welcome back",
    description: "Sign in to your workspace",
    submitLabel: "Sign in",
    submittingLabel: "Signing in…",
    errorFallback: "Sign in failed",
    alternateText: "Don't have an account?",
    alternateHref: "/sign-up",
    alternateAction: "Sign up",
  },
  "sign-up": {
    title: "Sign up",
    description: "Get started with your workspace",
    submitLabel: "Sign up",
    submittingLabel: "Signing up…",
    errorFallback: "Sign up failed",
    alternateText: "Already have an account?",
    alternateHref: "/sign-in",
    alternateAction: "Sign in",
  },
};

function resolveErrorMessage(message: string | undefined, fallback: string): string {
  return message ?? fallback;
}

async function submitSignIn(values: Pick<AuthFormValues, "email" | "password">): Promise<string | null> {
  try {
    const response = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });

    if (response.error) {
      return resolveErrorMessage(response.error.message, AUTH_CONTENT["sign-in"].errorFallback);
    }

    return null;
  } catch {
    return "An unexpected error occurred";
  }
}

async function submitSignUp(values: AuthFormValues): Promise<string | null> {
  try {
    const response = await authClient.signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
    });

    if (response.error) {
      return resolveErrorMessage(response.error.message, AUTH_CONTENT["sign-up"].errorFallback);
    }

    return null;
  } catch {
    return "An unexpected error occurred";
  }
}

export function AuthForm({ mode }: AuthFormProps): ReactNode {
  const [formValues, setFormValues] = useState<AuthFormValues>(INITIAL_FORM_VALUES);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const content: AuthContent = AUTH_CONTENT[mode];
  const shouldShowNameField: boolean = mode === "sign-up";

  const handleFieldChange =
    (field: keyof AuthFormValues) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const nextValue: string = event.target.value;
      setFormValues((previousValues: AuthFormValues): AuthFormValues => ({
        ...previousValues,
        [field]: nextValue,
      }));
    };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);

    const submitError: string | null =
      mode === "sign-in"
        ? await submitSignIn({ email: formValues.email, password: formValues.password })
        : await submitSignUp(formValues);

    if (submitError) {
      setErrorMessage(submitError);
      setIsSubmitting(false);
      return;
    }

    window.location.href = "/";
    setIsSubmitting(false);
  };

  return (
    <>
      <h1 className="mb-1 text-2xl font-bold text-foreground">{content.title}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{content.description}</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {shouldShowNameField ? (
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              type="text"
              placeholder="Your name"
              value={formValues.name}
              onChange={handleFieldChange("name")}
              required
              autoComplete="name"
            />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={formValues.email}
            onChange={handleFieldChange("email")}
            required
            autoComplete="email"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            placeholder={shouldShowNameField ? "Min. 8 characters" : "••••••••"}
            value={formValues.password}
            onChange={handleFieldChange("password")}
            required
            minLength={shouldShowNameField ? 8 : undefined}
            autoComplete={shouldShowNameField ? "new-password" : "current-password"}
          />
        </div>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? content.submittingLabel : content.submitLabel}
        </Button>
      </form>

      <p className="mt-4 text-center text-sm text-muted-foreground">
        {content.alternateText}{" "}
        <Link href={content.alternateHref} className="font-medium text-primary hover:underline">
          {content.alternateAction}
        </Link>
      </p>
    </>
  );
}
