"use client";

import { Activity, Bot, CircleHelp, FileUp, House, LayoutTemplate, Library, Plus, Settings, Wand, Workflow, Database } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Logo } from "./Logo";

const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/pipelines/new", label: "Create Pipeline", icon: Plus, highlight: true },
  { href: "/pipelines", label: "Pipelines", icon: Workflow },
  { href: "/sources", label: "Sources", icon: Database },
  { href: "/catalog", label: "Data Catalog", icon: Library },
  { href: "/studio", label: "Transformation Studio", icon: Wand },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/assistant", label: "AI Assistant", icon: Bot, ai: true },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : href === "/pipelines" ? path === "/pipelines" || (path.startsWith("/pipelines/") && !path.startsWith("/pipelines/new")) : path.startsWith(href));
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col bg-navy-950 text-slate-300 md:flex">
      <div className="px-5 pb-5 pt-5">
        <Link href="/">
          <Logo />
        </Link>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 scrollbar-thin" aria-label="Main">
        {NAV.map(({ href, label, icon: Icon, ai }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors",
                active ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-100",
              )}
            >
              <Icon className={cn("size-[18px]", active ? "text-brand-300" : ai ? "text-ai-300" : "text-slate-500 group-hover:text-slate-300")} />
              {label}
              {ai && <span className="ml-auto rounded bg-ai-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ai-200">AI</span>}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-2 border-t border-white/5 p-3">
        <Link href="/pipelines/new" className="flex items-center justify-center gap-2 rounded-lg gradient-primary px-3 py-2.5 text-sm font-semibold text-white shadow-glow hover:brightness-110">
          <Plus className="size-4" /> New Pipeline
        </Link>
        <Link href="/templates?import=1" className="flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-slate-400 hover:bg-white/5 hover:text-slate-100">
          <FileUp className="size-4" /> Import Template
        </Link>
        <Link href="/help" className="flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-slate-400 hover:bg-white/5 hover:text-slate-100">
          <CircleHelp className="size-4" /> Help & Documentation
        </Link>
      </div>
    </aside>
  );
}

export const NAV_ITEMS = NAV;
