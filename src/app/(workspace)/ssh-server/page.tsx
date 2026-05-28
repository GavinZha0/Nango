"use client";

import { PanelRedirectPage } from "@/components/layout/PanelRedirectPage";

/** /ssh-server — opens the SSH Hosts panel in the left sidebar. */
export default function SshServerIndexPage() {
  return <PanelRedirectPage panel="ssh-server" />;
}
