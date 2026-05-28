import { Header } from "@/components/layout/Header";
import { LeftToolbar } from "@/components/layout/LeftToolbar";
import { ThreePanelContent } from "@/components/layout/ThreePanelContent";
import { WorkspaceProvider } from "@/components/layout/WorkspaceProvider";
import { requireSession } from "@/lib/auth/route-guards";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  await requireSession();

  return (
    <WorkspaceProvider>
      <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
        {/* Top: horizontal header bar */}
        <Header />

        {/* Body: toolbar + three-panel workspace */}
        <div className="flex min-h-0 flex-1">
          {/* Left: fixed icon toolbar */}
          <LeftToolbar />

          {/* Resizable three-panel content (left panel + center + right panel) */}
          <ThreePanelContent>{children}</ThreePanelContent>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
