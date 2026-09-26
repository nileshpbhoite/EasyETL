"use client";

import { Activity, ArrowRight, Bot, ChevronRight, Database, House, LayoutTemplate, Library, Settings, Sparkles, SquarePlus, Wand, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Robot } from "@/components/art";
import { getStoredUser } from "@/lib/api";
import { useUI } from "@/lib/store";
import { cn, humanize } from "@/lib/utils";
import { Logo } from "./Logo";

const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/pipelines/new", label: "Create Pipeline", icon: SquarePlus },
  { href: "/pipelines", label: "Pipelines", icon: Workflow },
  { href: "/sources", label: "Sources", icon: Database },
  { href: "/catalog", label: "Data Catalog", icon: Library },
  { href: "/studio", label: "Transformation Studio", icon: Wand },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/assistant", label: "AI Assistant", icon: Bot },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/settings", label: "Settings", icon: Settings },
];

function CopilotCard() {
  const { openAssistant } = useUI();
  const [q, setQ] = useState("");
  const ask = () => {
    openAssistant(q.trim() ? { question: q.trim() } : {});
    setQ("");
  };
  return (
    <div className="relative overflow-hidden rounded-[18px] border border-white/80 bg-gradient-to-br from-white/80 via-brand-50/70 to-ai-100/70 p-3.5 shadow-card [@media(max-height:820px)]:hidden">
      <Robot size={64} className="absolute -right-2 -top-1" />
      <div className="flex items-center gap-2 text-[13.5px] font-bold text-slate-900">
        <span className="flex size-6 items-center justify-center rounded-lg bg-gradient-to-br from-ai-500 to-brand-500 text-white"><Sparkles className="size-3.5" /></span>
        AI Copilot
      </div>
      <p className="mt-2 pr-10 text-[11.5px] leading-snug text-slate-500">Get suggestions, explain transformations and optimize your pipeline.</p>
      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="mt-3 flex items-center gap-1.5 rounded-xl bg-white/90 py-1 pl-3 pr-1 ring-1 ring-slate-200/70">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything…" aria-label="Ask the AI Copilot" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-slate-400" />
        <button type="submit" aria-label="Send" className="gradient-primary flex size-7 shrink-0 items-center justify-center rounded-full text-white shadow-glow"><ArrowRight className="size-3.5" /></button>
      </form>
    </div>
  );
}

function UserCard() {
  const [user, setUser] = useState<ReturnType<typeof getStoredUser>>(null);
  useEffect(() => setUser(getStoredUser()), []);
  const initials = (user?.name ?? "U").split(" ").map((p) => p[0]).join("").slice(0, 2);
  return (
    <Link href="/settings" className="flex items-center gap-3 rounded-[16px] border border-white/80 bg-white/60 px-3 py-2.5 shadow-card transition-colors hover:bg-white/90">
      <span className="flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-ai-600 text-xs font-bold text-white">{initials}</span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[13px] font-semibold text-slate-900">{user?.name ?? "—"}</span>
        <span className="block truncate text-[11.5px] text-slate-500">{user?.role ? humanize(user.role) : ""}</span>
      </span>
      <ChevronRight className="size-4 text-slate-400" />
    </Link>
  );
}

export function Sidebar({ mobile, onNavigate }: { mobile?: boolean; onNavigate?: () => void } = {}) {
  const path = usePathname();
  // Pipeline wizard pages belong to "Create Pipeline"; the list itself to "Pipelines".
  const isActive = (href: string) =>
    href === "/" ? path === "/" : href === "/pipelines" ? path === "/pipelines" : href === "/pipelines/new" ? path.startsWith("/pipelines/") : path.startsWith(href);
  return (
    <aside
      onClick={(e) => { if ((e.target as HTMLElement).closest("a, button[type=submit]")) onNavigate?.(); }}
      className={cn("sidebar-bg w-[256px] shrink-0 flex-col", mobile ? "flex h-full" : "hidden md:flex")}
    >
      <div className="px-6 pb-6 pt-6">
        <Link href="/"><Logo dark={false} /></Link>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-4 scrollbar-thin" aria-label="Main">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex items-center gap-3.5 rounded-2xl px-4 py-3 text-[14px] font-medium transition-all",
                active ? "nav-active text-white" : "text-slate-700 hover:bg-white/80 hover:text-slate-900 hover:shadow-[0_4px_14px_-8px_rgb(76_70_180_/_0.35)]",
              )}
            >
              <Icon className={cn("size-[19px] shrink-0", active ? "text-white" : "text-slate-500 group-hover:text-brand-600")} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-3 p-4">
        <CopilotCard />
        <UserCard />
      </div>
    </aside>
  );
}
