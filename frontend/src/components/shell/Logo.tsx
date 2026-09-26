import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <div className={cn("relative flex size-8 items-center justify-center rounded-xl gradient-primary shadow-glow", className)}>
      <svg viewBox="0 0 24 24" className="size-5 text-white" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h9" />
        <path d="M4 12h13" />
        <path d="M4 17h9" />
        <path d="M17 5l3 2-3 2" />
        <path d="M17 15l3 2-3 2" />
      </svg>
    </div>
  );
}

export function Logo({ dark = true }: { dark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <div className="leading-tight">
        <div className={cn("text-[15px] font-semibold tracking-tight", dark ? "text-white" : "text-slate-900")}>EasyETL</div>
        <div className={cn("text-[10px] font-medium uppercase tracking-[0.12em]", dark ? "text-brand-300" : "text-brand-600")}>for Databricks</div>
      </div>
    </div>
  );
}
