import { KeyRound, UserRound } from "lucide-react";
import { getSession } from "@/lib/auth/auth-instance";
import { NameField } from "./NameField";
import { PasswordField } from "./PasswordField";
import { TimezoneField } from "./TimezoneField";
import { StatsDashboard } from "./StatsDashboard";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface ReadOnlyFieldProps {
  label: string;
  value: string;
}

function ReadOnlyField({ label, value }: ReadOnlyFieldProps): React.ReactNode {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="truncate text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function formatRole(role: string | null | undefined): string {
  if (!role) {
    return "user";
  }
  return role;
}

export default async function ProfilePage(): Promise<React.ReactNode> {
  const session = await getSession();
  const userName: string = session?.user?.name ?? "Unknown";
  const userEmail: string = session?.user?.email ?? "";
  const userRole: string = formatRole(session?.user?.role);
  // better-auth additionalFields are present at runtime but TS doesn't
  // narrow the session type to include them here; cast locally.
  const userFields = session?.user as
    | { timezone?: string | null; timezoneFollowBrowser?: boolean | null }
    | undefined;
  const userTimezone: string | null = userFields?.timezone ?? null;
  const userFollowBrowser: boolean = userFields?.timezoneFollowBrowser ?? true;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6 md:p-8">
        {/* Page heading */}
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        </div>

        {/* Two-column: Basic Info | Password */}
        <div className="grid items-stretch gap-6 md:grid-cols-2">
          {/* Basic Info card */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-primary/10 p-1.5">
                  <UserRound className="h-4 w-4 text-primary" />
                </div>
                <CardTitle>Basic Info</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              <NameField initial={userName} />
              <ReadOnlyField label="Email" value={userEmail || "-"} />
              <ReadOnlyField label="Role" value={userRole} />
              <TimezoneField initial={userTimezone} initialFollowBrowser={userFollowBrowser} />
            </CardContent>
          </Card>

          {/* Password card */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-primary/10 p-1.5">
                  <KeyRound className="h-4 w-4 text-primary" />
                </div>
                <CardTitle>Password</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <PasswordField />
            </CardContent>
          </Card>
        </div>

        {/* Divider */}
        <hr className="border-border" />

        {/* Resource stats */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Resource usage (last 30 days)</h2>
          <StatsDashboard />
        </div>
      </div>
    </ScrollArea>
  );
}
