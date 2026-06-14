"use client";

/**
 * PasswordField — change password on the Profile page.
 *
 * Three inputs: current password, new password, confirm new password.
 * Calls better-auth's `authClient.changePassword()` which validates
 * the current password server-side before updating.
 */

import { useState, type ReactNode } from "react";
import { Loader2, Eye, EyeOff } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const MIN_PASSWORD_LENGTH = 8;

export function PasswordField(): ReactNode {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const canSubmit =
    currentPassword.length > 0
    && newPassword.length >= MIN_PASSWORD_LENGTH
    && newPassword === confirmPassword
    && !saving;

  function validate(): string | null {
    if (!currentPassword) return "Current password is required.";
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (newPassword !== confirmPassword) return "Passwords do not match.";
    if (newPassword === currentPassword) {
      return "New password must be different from current password.";
    }
    return null;
  }

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
        currentPassword,
        newPassword,
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

    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setSuccess(true);
  };

  function clearState(): void {
    setError(null);
    setSuccess(false);
  }

  return (
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
              value={currentPassword}
              onChange={(e) => { setCurrentPassword(e.target.value); clearState(); }}
              placeholder="Enter current password"
              autoComplete="current-password"
            />
            <button
              type="button"
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
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); clearState(); }}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              autoComplete="new-password"
            />
            <button
              type="button"
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
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); clearState(); }}
            placeholder="Re-enter new password"
            autoComplete="new-password"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit}
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            "Change Password"
          )}
        </Button>
        {success && (
          <span className="text-[11px] text-emerald-500">
            Password changed successfully.
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </form>
  );
}
