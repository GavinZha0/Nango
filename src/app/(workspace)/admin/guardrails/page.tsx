import "server-only";

import { requireAdmin } from "@/lib/auth/route-guards";
import { GuardrailsClientShell } from "./GuardrailsClientShell";

export const metadata = {
  title: "Guardrails Control Plane — Nango Admin",
  description: "Security posture visualizer, tool risk overrides, safety policies & audit logs",
};

export default async function GuardrailsAdminPage() {
  await requireAdmin();
  return <GuardrailsClientShell />;
}
