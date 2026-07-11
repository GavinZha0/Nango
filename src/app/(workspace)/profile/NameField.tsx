"use client";

/**
 * NameField — editable display name on the Profile page.
 */

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface NameFieldProps {
  initial: string;
}

export function NameField({ initial }: NameFieldProps): ReactNode {
  const [value, setValue] = useState<string>(initial);
  const [saved, setSaved] = useState<string>(initial);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<boolean>(false);

  const dirty = value.trim() !== saved.trim();

  const save = async (): Promise<void> => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Name cannot be empty.");
      return;
    }
    setError(null);
    setSaving(true);
    const res = await authClient
      .updateUser({ name: trimmed })
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
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Name
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setJustSaved(false);
          }}
          placeholder="Your name"
          className="max-w-[300px]"
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
