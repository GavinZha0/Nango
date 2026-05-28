"use client";

import { PanelRedirectPage } from "@/components/layout/PanelRedirectPage";

/** /agent — opens the Agent panel in the left sidebar. */
export default function AgentPage() {
  return <PanelRedirectPage panel="agent" />;
}
