"use client";

/**
 * Timezone field for the Profile page — display + edit.
 *
 * This is the user's only entry point to manually change their primary
 * timezone after the browser auto-detect has run on first session.
 * The "Detect" button is a re-detect shortcut for users who change
 * locations and want to resync without typing an IANA name.
 *
 * Validation happens locally before the PATCH — `Intl.DateTimeFormat`
 * rejects unknown IANA names with RangeError, which we surface as an
 * inline error instead of letting better-auth round-trip just to fail.
 */

import { useState, type ReactNode } from "react";
import { Clock, Loader2, RefreshCw } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface TimezoneFieldProps {
  /** Current `user.timezone` from the session (null when never set). */
  initial: string | null;
}

/** True iff `tz` is an IANA zone the runtime can format with. Mirrors
 *  the server-side helper in lib/time/tz-validate-style logic; kept
 *  local (5 lines) to avoid pulling a server-only module into the
 *  client bundle. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function TimezoneField({ initial }: TimezoneFieldProps): ReactNode {
  const [value, setValue] = useState<string>(initial ?? "");
  const [saved, setSaved] = useState<string>(initial ?? "");
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<boolean>(false);

  const dirty = value.trim() !== saved.trim();

  const detectFromBrowser = (): void => {
    try {
      const browserTz =
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      setValue(browserTz);
      setError(null);
      setJustSaved(false);
    } catch {
      setValue("UTC");
    }
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
    <div className="flex items-start gap-3 rounded-lg border bg-card p-4">
      <div className="mt-0.5 rounded-md bg-primary/10 p-2">
        <Clock className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Timezone
        </p>
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
            aria-invalid={error !== null || undefined}
          />
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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={detectFromBrowser}
            title="Use the browser's current timezone"
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Detect
          </Button>
          {justSaved && !dirty && (
            <span className="text-[11px] text-muted-foreground">Saved.</span>
          )}
        </div>
        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          Used by all agents via <code>get_current_datetime</code> and as
          the default for new schedules. IANA name — e.g.{" "}
          <code>Asia/Shanghai</code>, <code>America/New_York</code>,{" "}
          <code>UTC</code>.
        </p>
      </div>
    </div>
  );
}
