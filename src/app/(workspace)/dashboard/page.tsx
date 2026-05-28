"use client";

import { PanelRedirectPage } from "@/components/layout/PanelRedirectPage";

/** /dashboard — opens the Dashboard panel in the left sidebar. */
export default function DashboardPage() {
  return <PanelRedirectPage panel="dashboard" />;
}
