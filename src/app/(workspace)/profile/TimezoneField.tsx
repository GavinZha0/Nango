"use client";

/**
 * Timezone field for the Profile page — display + edit.
 *
 * Two modes controlled by the "Follow browser" toggle:
 *
 *   followBrowser = true (default):
 *     The profile timezone is automatically synced to the browser's
 *     timezone on every session load. The IANA input is read-only —
 *     it shows the current value but cannot be edited manually.
 *
 *   followBrowser = false:
 *     The user picks a fixed IANA timezone. The value is never
 *     auto-overwritten, even when the browser timezone changes.
 *
 * Validation happens locally before the PATCH — `Intl.DateTimeFormat`
 * rejects unknown IANA names with RangeError, which we surface as an
 * inline error instead of letting better-auth round-trip just to fail.
 */

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface TimezoneFieldProps {
  /** Current `user.timezone` from the session (null when never set). */
  initial: string | null;
  /** Current `user.timezoneFollowBrowser` (defaults to true). */
  initialFollowBrowser?: boolean;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function TimezoneField({
  initial,
  initialFollowBrowser = true,
}: TimezoneFieldProps): ReactNode {
  const [followBrowser, setFollowBrowser] = useState<boolean>(initialFollowBrowser);
  const [value, setValue] = useState<string>(initial ?? getBrowserTimezone());
  const [saved, setSaved] = useState<string>(initial ?? "");
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<boolean>(false);

  const dirty = !followBrowser && value.trim() !== saved.trim();

  const toggleFollowBrowser = async (checked: boolean): Promise<void> => {
    setFollowBrowser(checked);
    setError(null);
    setJustSaved(false);
    setSaving(true);

    const updates: Record<string, unknown> = {
      timezoneFollowBrowser: checked,
    };
    if (checked) {
      const browserTz = getBrowserTimezone();
      updates.timezone = browserTz;
      setValue(browserTz);
    }

    const res = await authClient
      .updateUser(updates)
      .catch((err: unknown) => ({
        error: { message: err instanceof Error ? err.message : String(err) },
      }));
    setSaving(false);

    if (res && "error" in res && res.error) {
      setFollowBrowser(!checked);
      setError("Failed to update. Please try again.");
      return;
    }
    setSaved(checked ? (updates.timezone as string) : value.trim());
    setJustSaved(true);
  };

  const save = async (): Promise<void> => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Timezone cannot be empty.");
      return;
    }
    if (!isValidTimeZone(trimmed)) {
      setError(`'${trimmed}' is not a valid IANA timezone name.`);
      return;
    }
    setError(null);
    setSaving(true);
    const res = await authClient
      .updateUser({ timezone: trimmed })
      .catch((err: unknown) => ({
        error: { message: err instanceof Error ? err.message : String(err) },
      }));
    setSaving(false);
    if (res && "error" in res && res.error) {
      setError(
        ("message" in res.error && typeof res.error.message === "string"
          ? res.error.message
          : null) ?? "Save failed. Please try again.",
      );
      return;
    }
    setSaved(trimmed);
    setValue(trimmed);
    setJustSaved(true);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Timezone
      </p>

      {/* Follow-browser toggle */}
      <div className="flex items-center gap-2">
        <Switch
          id="tz-follow-browser"
          checked={followBrowser}
          onCheckedChange={(c) => void toggleFollowBrowser(c)}
          disabled={saving}
        />
        <Label htmlFor="tz-follow-browser" className="text-sm">
          Follow browser
        </Label>
      </div>

      {/* Timezone input */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setJustSaved(false);
          }}
          placeholder="e.g. Asia/Shanghai"
          className="max-w-xs"
          disabled={followBrowser}
          aria-invalid={error !== null || undefined}
        />
        {!followBrowser && (
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Save"
            )}
          </Button>
        )}
        {justSaved && !dirty && (
          <span className="text-[11px] text-muted-foreground">Saved.</span>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
