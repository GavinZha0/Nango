"use client";

import { PanelRedirectPage } from "@/components/layout/PanelRedirectPage";

/** /datasource — opens the Data Sources panel in the left sidebar. */
export default function DataSourceIndexPage() {
  return <PanelRedirectPage panel="datasource" />;
}
