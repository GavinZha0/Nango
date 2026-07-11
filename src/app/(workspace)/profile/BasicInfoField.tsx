"use client";

import { useState, type ReactNode } from "react";
import { UserRound, Loader2 } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface BasicInfoFieldProps {
  userName: string;
  userEmail: string;
  userRole: string;
  initialTimezone: string | null;
  initialFollowBrowser: boolean;
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

interface ReadOnlyFieldProps {
  label: string;
  value: string;
}

function ReadOnlyField({ label, value }: ReadOnlyFieldProps): ReactNode {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
        {label}
      </p>
      <p className="truncate text-xs font-medium text-foreground">{value}</p>
    </div>
  );
}

export function BasicInfoField({
  userName,
  userEmail,
  userRole,
  initialTimezone,
  initialFollowBrowser = true,
}: BasicInfoFieldProps): ReactNode {
  // References
  const [refName, setRefName] = useState(userName);
  const [refFollowBrowser, setRefFollowBrowser] = useState(initialFollowBrowser);
  const [refTimezone, setRefTimezone] = useState(initialTimezone || getBrowserTimezone());

  // States
  const [nameVal, setNameVal] = useState(userName);
  const [followBrowserVal, setFollowBrowserVal] = useState(initialFollowBrowser);
  const [timezoneVal, setTimezoneVal] = useState(initialTimezone || getBrowserTimezone());

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    nameVal.trim() !== refName.trim() ||
    followBrowserVal !== refFollowBrowser ||
    (!followBrowserVal && timezoneVal.trim() !== refTimezone.trim());

  const handleToggleFollow = (checked: boolean) => {
    setFollowBrowserVal(checked);
    setError(null);
    if (checked) {
      setTimezoneVal(getBrowserTimezone());
    }
  };

  const handleSave = async () => {
    const trimmedName = nameVal.trim();
    if (!trimmedName) {
      setError("Name cannot be empty.");
      return;
    }

    let targetTimezone = timezoneVal.trim();
    if (followBrowserVal) {
      targetTimezone = getBrowserTimezone();
    }

    if (!targetTimezone) {
      setError("Timezone cannot be empty.");
      return;
    }

    if (!followBrowserVal && !isValidTimeZone(targetTimezone)) {
      setError(`'${targetTimezone}' is not a valid IANA timezone name.`);
      return;
    }

    setSaving(true);
    setError(null);

    const updates: Record<string, unknown> = {};
    if (nameVal.trim() !== refName.trim()) {
      updates.name = nameVal.trim();
    }
    if (followBrowserVal !== refFollowBrowser) {
      updates.timezoneFollowBrowser = followBrowserVal;
    }
    if (followBrowserVal || timezoneVal.trim() !== refTimezone.trim()) {
      updates.timezone = targetTimezone;
    }

    const res = await authClient
      .updateUser(updates)
      .catch((err: unknown) => ({
        error: { message: err instanceof Error ? err.message : String(err) },
      }));

    setSaving(false);

    if (res && "error" in res && res.error) {
      setError("Failed to save basic info.");
      return;
    }

    setRefName(nameVal.trim());
    setRefFollowBrowser(followBrowserVal);
    setRefTimezone(targetTimezone);
    setTimezoneVal(targetTimezone);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-primary/10 p-1.5">
            <UserRound className="h-4 w-4 text-primary" />
          </div>
          <CardTitle className="text-base">Basic Info</CardTitle>
        </div>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={handleSave}
          className="h-8 px-3 text-xs"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Name Input */}
        <div className="space-y-1">
          <Label htmlFor="basic-name-input" className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
            Name
          </Label>
          <Input
            id="basic-name-input"
            value={nameVal}
            onChange={(e) => {
              setNameVal(e.target.value);
              setError(null);
            }}
            placeholder="Your name"
            className="w-full h-8 text-xs"
            disabled={saving}
          />
        </div>

        {/* Read-Only: Email & Role */}
        <ReadOnlyField label="Email" value={userEmail || "-"} />
        <ReadOnlyField label="Role" value={userRole} />

        {/* Timezone Settings */}
        <div className="space-y-2 pt-2 border-t border-border/40">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
            Timezone
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="basic-tz-follow-browser"
              checked={followBrowserVal}
              onCheckedChange={handleToggleFollow}
              disabled={saving}
            />
            <Label htmlFor="basic-tz-follow-browser" className="text-xs font-medium text-foreground">
              Follow browser
            </Label>
          </div>
          <div className="space-y-1">
            <Label
              htmlFor="basic-timezone-input"
              className={`text-[10px] font-bold uppercase tracking-wide ${
                followBrowserVal ? "text-muted-foreground/30" : "text-muted-foreground/60"
              }`}
            >
              Timezone name
            </Label>
            <Input
              id="basic-timezone-input"
              value={timezoneVal}
              onChange={(e) => {
                setTimezoneVal(e.target.value);
                setError(null);
              }}
              placeholder="e.g. Asia/Shanghai"
              className="w-full h-8 text-xs"
              disabled={followBrowserVal || saving}
            />
          </div>
        </div>

        {error && (
          <p className="text-xs text-destructive pt-1">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
