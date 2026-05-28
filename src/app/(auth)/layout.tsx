import Image from "next/image";
import { redirectIfAuthenticated } from "@/lib/auth/route-guards";

/* ─── Auth route-group layout ────────────────────────────────────────────── */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  await redirectIfAuthenticated();

  return (
    <div className="flex min-h-screen w-full bg-[#0f1117]">

      {/* ── Left panel ──────────────────────────────────────────────────── */}
      <div className="hidden xl:flex xl:w-[52%] flex-shrink-0 flex-col relative">
        <div className="absolute inset-0 bg-gradient-to-br from-[#1e2a6e] via-[#2c3cad] to-[#1a237e]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_40%,rgba(99,120,255,0.25)_0%,transparent_65%)]" />
        <div className="relative z-10 flex h-full flex-col px-12 py-10">
          <div className="flex items-center gap-3">
            <Image src="/logo.png" alt="Nango logo" width={40} height={40}
              className="rounded-full ring-2 ring-white/20" />
            <span className="text-xl font-bold tracking-wide text-white">Nango</span>
          </div>
          <div className="flex flex-1 items-center justify-center py-8">
            <Image
              src="/background.png"
              alt="Nango background visual"
              width={820}
              height={560}
              className="h-auto w-full max-w-2xl object-contain"
              priority
            />
          </div>
          <div className="pb-4">
            <p className="text-2xl font-bold leading-snug text-white whitespace-nowrap">
              Turn ideas into reality, together.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-white/60">
              Nango — an AI-first artifact workspace. Generate dashboards,
              images, and reports through natural conversation. Everything
              you create is saved, not just a chat message.
            </p>
          </div>
        </div>
      </div>

      {/* ── Vertical divider ────────────────────────────────────────────── */}
      <div className="hidden xl:block w-px bg-white/10 flex-shrink-0" />

      {/* ── Right panel — page-specific form ────────────────────────────── */}
      <div className="flex flex-1 items-center justify-center px-8">
        <div className="w-full max-w-sm">

          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-3 xl:hidden">
            <Image src="/logo.png" alt="Nango logo" width={36} height={36}
              className="rounded-full" />
            <span className="text-xl font-bold tracking-tight text-foreground">Nango</span>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}
