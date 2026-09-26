"use client";

import { ArrowRight, Check } from "lucide-react";
import { STEPS, type Step } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Stepper({ current, completed, onSelect, deployed }: { current: Step; completed: Step[]; onSelect: (s: Step) => void; deployed: boolean }) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);
  const furthest = Math.max(currentIdx, ...completed.map((c) => STEPS.findIndex((x) => x.id === c)), 0);
  return (
    <nav aria-label="Pipeline steps" className="flex items-center gap-1 overflow-x-auto rounded-2xl border border-slate-200/80 bg-white px-3 py-2.5 shadow-card scrollbar-thin">
      {STEPS.map((s, i) => {
        const done = completed.includes(s.id) || (s.id === "monitor" && deployed);
        const active = s.id === current;
        const reachable = i <= furthest + 1;
        return (
          <div key={s.id} className="flex min-w-0 flex-1 items-center">
            <button
              onClick={() => reachable && onSelect(s.id)}
              disabled={!reachable}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-2 py-2 text-left transition-colors",
                active ? "border-brand-500 bg-brand-50/60 shadow-[0_4px_14px_-8px_rgb(38_89_235)]" : "border-transparent hover:bg-slate-50",
                !reachable && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="relative shrink-0">
                <span
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full text-[14px] font-semibold",
                    active || done ? "bg-brand-600 text-white shadow-[0_4px_12px_-4px_rgb(38_89_235)]" : "bg-brand-50 text-brand-600",
                  )}
                >
                  {i + 1}
                </span>
                {done && !active && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-white">
                    <Check className="size-2.5 text-white" strokeWidth={3.5} />
                  </span>
                )}
              </span>
              <span className="min-w-0 leading-tight">
                <span className={cn("block whitespace-nowrap text-[13.5px] font-semibold", active ? "text-brand-700" : "text-slate-900")}>{s.label}</span>
                <span className="block truncate text-[11.5px] text-slate-500">{s.hint}</span>
              </span>
            </button>
            {i < STEPS.length - 1 && <ArrowRight className="mx-0.5 size-3.5 shrink-0 text-slate-300" />}
          </div>
        );
      })}
    </nav>
  );
}
