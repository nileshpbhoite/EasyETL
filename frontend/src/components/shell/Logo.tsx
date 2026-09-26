import { useId } from "react";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  const id = `lm${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} fill="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8fb2ff" />
          <stop offset="1" stopColor="#2f6bff" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 28 9.25v13.5L16 29.5 4 22.75V9.25L16 2.5Z" stroke={`url(#${id})`} strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M16 9.5 22 13v6.5L16 23l-6-3.5V13l6-3.5Z" fill={`url(#${id})`} />
      <path d="M10 13l6 3.5 6-3.5M16 16.5V23" stroke="#0b1235" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ dark = true }: { dark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark className="size-9" />
      <div className="leading-tight">
        <div className={cn("font-display text-[18px] font-bold tracking-tight", dark ? "text-white" : "text-slate-900")}>{BRAND.name}</div>
        <div className={cn("whitespace-nowrap text-[10.5px]", dark ? "text-slate-400" : "text-slate-500")}>{BRAND.tagline}</div>
      </div>
    </div>
  );
}
