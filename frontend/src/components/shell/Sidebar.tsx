"use client";

import { Activity, ArrowRight, Bot, CircleHelp, Database, House, LayoutTemplate, Library, Settings, Sparkles, SquarePlus, Wand, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUI } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Logo } from "./Logo";

const GROUPS = [
  { label: null, items: [{ href: "/", label: "Home", icon: House }] },
  {
    label: "Build",
    items: [
      { href: "/pipelines/new", label: "Create Pipeline", icon: SquarePlus },
      { href: "/pipelines", label: "My Pipelines", icon: Workflow },
      { href: "/studio", label: "Transformation Studio", icon: Wand },
      { href: "/templates", label: "Templates", icon: LayoutTemplate },
    ],
  },
  {
    label: "Data",
    items: [
      { href: "/sources", label: "Sources", icon: Database },
      { href: "/catalog", label: "Data Catalog", icon: Library },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/monitoring", label: "Monitoring", icon: Activity },
      { href: "/assistant", label: "AI Assistant", icon: Bot },
    ],
  },
];

const FOOTER = [
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/help", label: "Help & Docs", icon: CircleHelp },
];

export function Sidebar({ mobile, onNavigate }: { mobile?: boolean; onNavigate?: () => void } = {}) {
  const path = usePathname();
  const { openAssistant } = useUI();
  // Pipeline wizard pages belong to "Create Pipeline"; the list itself to "My Pipelines".
  const isActive = (href: string) =>
    href === "/" ? path === "/" : href === "/pipelines" ? path === "/pipelines" : href === "/pipelines/new" ? path.startsWith("/pipelines/") : path.startsWith(href);

  const item = ({ href, label, icon: Icon }: { href: string; label: string; icon: typeof House }) => {
    const active = isActive(href);
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition-all",
          active ? "bg-gradient-to-r from-brand-600 to-brand-500 text-white shadow-[0_8px_20px_-10px_rgb(59_110_246)]" : "text-slate-300 hover:bg-white/[0.06] hover:text-white",
        )}
      >
        <Icon className={cn("size-[18px] transition-colors", active ? "text-white" : "text-slate-400 group-hover:text-white")} />
        {label}
      </Link>
    );
  };

  return (
    <aside onClick={(e) => { if ((e.target as HTMLElement).closest("a, button")) onNavigate?.(); }} className={cn("sidebar-bg w-[240px] shrink-0 flex-col text-slate-300", mobile ? "flex h-full" : "hidden md:flex")}>
      <div className="px-5 pb-5 pt-5">
        <Link href="/"><Logo /></Link>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 scrollbar-thin" aria-label="Main">
        {GROUPS.map((g, i) => (
          <div key={i} className="space-y-1">
            {g.label && <div className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">{g.label}</div>}
            {g.items.map(item)}
          </div>
        ))}
      </nav>
      <div className="space-y-1 px-3 pb-2 pt-3">{FOOTER.map(item)}</div>
      <div className="p-3 pt-1">
        <button
          onClick={() => openAssistant({})}
          className="group w-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-ai-600/30 via-brand-600/20 to-transparent p-3.5 text-left transition-all hover:border-ai-300/40"
        >
          <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-ai-500 to-brand-500 shadow-lg"><Sparkles className="size-3.5" /></span>
            Need a hand?
          </div>
          <div className="mt-1.5 text-[12px] leading-snug text-slate-300/80">Ask the AI Copilot anything about your data or pipeline.</div>
          <div className="mt-3 flex items-center justify-between rounded-lg bg-white/10 px-3 py-2 text-[12px] font-medium text-white/90 group-hover:bg-white/15">
            Ask AI Copilot <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </div>
        </button>
      </div>
    </aside>
  );
}
