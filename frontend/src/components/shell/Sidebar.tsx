"use client";

import { Activity, ArrowRight, Bot, CircleHelp, Database, FileUp, House, LayoutTemplate, Library, Plus, Settings, Sparkles, SquarePlus, Wand, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUI } from "@/lib/store";
import { cn } from "@/lib/utils";
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

export function Sidebar() {
  const path = usePathname();
  const { openAssistant } = useUI();
  // Pipeline wizard pages belong to "Create Pipeline" (as in the design); the list itself to "Pipelines".
  const isActive = (href: string) =>
    href === "/" ? path === "/" : href === "/pipelines" ? path === "/pipelines" : href === "/pipelines/new" ? path.startsWith("/pipelines/") : path.startsWith(href);
  return (
    <aside className="hidden w-[232px] shrink-0 flex-col bg-navy-950 text-slate-300 md:flex">
      <div className="px-5 pb-6 pt-5">
        <Link href="/"><Logo /></Link>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 scrollbar-thin" aria-label="Main">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors",
                active ? "bg-brand-600 text-white shadow-[0_6px_18px_-8px_rgb(38_89_235)]" : "text-slate-300 hover:bg-white/5 hover:text-white",
              )}
            >
              <Icon className={cn("size-[18px]", active ? "text-white" : "text-slate-400")} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-3 p-3">
        <div className="rounded-xl border border-white/5 bg-white/[0.04] p-3">
          <div className="mb-1.5 px-1 text-[12.5px] font-semibold text-white">Quick Actions</div>
          {[
            { href: "/pipelines/new", icon: Plus, label: "New Pipeline" },
            { href: "/templates?import=1", icon: FileUp, label: "Import Template" },
            { href: "/help", icon: CircleHelp, label: "Help & Documentation" },
          ].map((q) => (
            <Link key={q.label} href={q.href} className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-[12.5px] text-slate-300 hover:bg-white/5 hover:text-white">
              <span className="flex size-5 items-center justify-center rounded bg-white/10"><q.icon className="size-3" /></span>
              {q.label}
            </Link>
          ))}
        </div>
        <button onClick={() => openAssistant({})} className="w-full rounded-xl border border-white/5 bg-gradient-to-br from-white/[0.07] to-white/[0.02] p-3 text-left transition-colors hover:border-brand-400/40">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <span className="flex size-6 items-center justify-center rounded-full bg-gradient-to-br from-ai-500 to-brand-500"><Sparkles className="size-3.5" /></span>
            AI Copilot
          </div>
          <div className="mt-1 text-[11.5px] leading-snug text-slate-400">Get suggestions, explain transformations and optimize your pipeline</div>
          <div className="mt-2.5 flex items-center justify-between rounded-lg bg-white/5 px-2.5 py-2 text-[11.5px] text-slate-400">
            Ask anything about your data… <ArrowRight className="size-3.5" />
          </div>
        </button>
      </div>
    </aside>
  );
}
