import { UserRound, Mail, Shield } from "lucide-react";
import { getSession } from "@/lib/auth/auth-instance";
import { TimezoneField } from "./TimezoneField";

interface ProfileFieldProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}

function ProfileField({ icon: Icon, label, value }: ProfileFieldProps): React.ReactNode {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-4">
      <div className="mt-0.5 rounded-md bg-primary/10 p-2">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="truncate text-sm font-medium text-foreground">{value}</p>
      </div>
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
  const userTimezone: string | null =
    (session?.user as { timezone?: string | null } | undefined)?.timezone
    ?? null;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 p-6 md:p-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your basic account information.
        </p>
      </div>

      <div className="grid gap-4">
        <ProfileField icon={UserRound} label="Name" value={userName} />
        <ProfileField icon={Mail} label="Email" value={userEmail || "-"} />
        <ProfileField icon={Shield} label="Role" value={userRole} />
        <TimezoneField initial={userTimezone} />
      </div>
    </div>
  );
}
