"use client";

/**
 * PasswordField — change password on the Profile page.
 *
 * Three inputs: current password, new password, confirm new password.
 * Calls better-auth's `authClient.changePassword()` which validates
 * the current password server-side before updating.
 */

import { useState, type ReactNode } from "react";
import { Loader2, Eye, EyeOff, KeyRound } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const MIN_PASSWORD_LENGTH = 8;

interface FormState {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const EMPTY_FORM: FormState = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

export function PasswordField(): ReactNode {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  function validate(): string | null {
    if (!form.currentPassword) return "Current password is required.";
    if (form.newPassword.length < MIN_PASSWORD_LENGTH) {
      return `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (form.newPassword !== form.confirmPassword) return "Passwords do not match.";
    if (form.newPassword === form.currentPassword) {
      return "New password must be different from current password.";
    }
    return null;
  }

  const canSubmit = !saving && validate() === null;

  const save = async (): Promise<void> => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSuccess(false);
    setSaving(true);

    const res = await authClient
      .changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
        revokeOtherSessions: false,
      })
      .catch((err: unknown) => ({
        error: { message: err instanceof Error ? err.message : String(err) },
      }));

    setSaving(false);

    if (res && "error" in res && res.error) {
      const msg =
        "message" in res.error && typeof res.error.message === "string"
          ? res.error.message
          : null;
      setError(msg ?? "Failed to change password. Please check your current password.");
      return;
    }

    setForm(EMPTY_FORM);
    setSuccess(true);
  };

  function clearState(): void {
    setError(null);
    setSuccess(false);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-primary/10 p-1.5">
            <KeyRound className="h-4 w-4 text-primary" />
          </div>
          <CardTitle className="text-base">Password</CardTitle>
        </div>
        <Button
          size="sm"
          disabled={!canSubmit || saving}
          onClick={() => void save()}
          className="h-8 px-3 text-xs"
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            "Save"
          )}
        </Button>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          <div className="grid gap-3">
            {/* Current password */}
            <div className="space-y-1">
              <Label htmlFor="pw-current" className="text-xs">
                Current password
              </Label>
              <div className="relative">
                <Input
                  id="pw-current"
                  type={showCurrent ? "text" : "password"}
                  value={form.currentPassword}
                  onChange={(e) => { update("currentPassword", e.target.value); clearState(); }}
                  placeholder="Enter current password"
                  autoComplete="current-password"
                  className="h-8 text-xs"
                />
                <button
                  type="button"
                  aria-label={showCurrent ? "Hide current password" : "Show current password"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowCurrent(!showCurrent)}
                  tabIndex={-1}
                >
                  {showCurrent
                    ? <EyeOff className="h-3.5 w-3.5" />
                    : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            {/* New password */}
            <div className="space-y-1">
              <Label htmlFor="pw-new" className="text-xs">
                New password
              </Label>
              <div className="relative">
                <Input
                  id="pw-new"
                  type={showNew ? "text" : "password"}
                  value={form.newPassword}
                  onChange={(e) => { update("newPassword", e.target.value); clearState(); }}
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                  autoComplete="new-password"
                  className="h-8 text-xs"
                />
                <button
                  type="button"
                  aria-label={showNew ? "Hide new password" : "Show new password"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowNew(!showNew)}
                  tabIndex={-1}
                >
                  {showNew
                    ? <EyeOff className="h-3.5 w-3.5" />
                    : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            {/* Confirm new password */}
            <div className="space-y-1">
              <Label htmlFor="pw-confirm" className="text-xs">
                Confirm new password
              </Label>
              <Input
                id="pw-confirm"
                type="password"
                value={form.confirmPassword}
                onChange={(e) => { update("confirmPassword", e.target.value); clearState(); }}
                placeholder="Re-enter new password"
                autoComplete="new-password"
                className="h-8 text-xs"
              />
            </div>
          </div>

          {success && (
            <p className="text-[11px] text-emerald-500 pt-1">
              Password changed successfully.
            </p>
          )}

          {error && (
            <p className="text-xs text-destructive pt-1">{error}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
