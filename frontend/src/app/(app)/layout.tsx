"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AssistantPanel } from "@/components/shell/AssistantPanel";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { getToken } from "@/lib/api";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!getToken()) router.replace("/login");
    else setReady(true);
  }, [router]);
  if (!ready) return <div className="h-screen bg-canvas" />;
  return (
    <div className="app-bg flex h-screen overflow-hidden">
      <Sidebar />
      {navOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-navy-950/50 backdrop-blur-sm animate-fade-in" onClick={() => setNavOpen(false)} />
          <div className="relative h-full w-[240px] shadow-2xl animate-slide-up"><Sidebar mobile onNavigate={() => setNavOpen(false)} /></div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-16 border-b border-slate-200 bg-white" />}>
          <Topbar onMenu={() => setNavOpen(true)} />
        </Suspense>
        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</main>
      </div>
      <AssistantPanel />
    </div>
  );
}
