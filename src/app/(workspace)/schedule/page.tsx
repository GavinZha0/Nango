"use client";

import { PanelRedirectPage } from "@/components/layout/PanelRedirectPage";

/** /schedule — opens the Schedules panel in the left sidebar. */
export default function SchedulePage() {
  return <PanelRedirectPage panel="schedules" />;
}
