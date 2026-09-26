"use client";

import { Check } from "lucide-react";
import { STEPS, type Step } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Stepper({ current, completed, onSelect, deployed }: { current: Step; completed: Step[]; onSelect: (s: Step) => void; deployed: boolean }) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);
  return (
    <nav aria-label="Pipeline steps" className="flex items-center overflow-x-auto scrollbar-thin">
      {STEPS.map((s, i) => {
        const done = completed.includes(s.id) || (s.id === "monitor" && deployed);
        const active = s.id === current;
        const reachable = i <= Math.max(currentIdx, ...completed.map((c) => STEPS.findIndex((x) => x.id === c)), 0) + 1;
        return (
          <div key={s.id} className="flex shrink-0 items-center">
            <button
              onClick={() => reachable && onSelect(s.id)}
              disabled={!reachable}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                active ? "bg-brand-50" : reachable ? "hover:bg-slate-100" : "cursor-not-allowed opacity-50",
              )}
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-xs font-semibold transition-all",
                  active ? "gradient-primary text-white shadow-glow" : done ? "bg-emerald-500 text-white" : "border border-slate-300 bg-white text-slate-500",
                )}
              >
                {done && !active ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className="hidden leading-tight min-[1800px]:block">
                <span className={cn("block text-[13px] font-semibold", active ? "text-brand-700" : "text-slate-700")}>{s.label}</span>
                <span className="block text-[10.5px] text-slate-400">{s.hint}</span>
              </span>
              <span className={cn("text-[13px] font-semibold min-[1800px]:hidden", active ? "text-brand-700" : "text-slate-700")}>{s.label}</span>
            </button>
            {i < STEPS.length - 1 && <div className={cn("mx-1 h-px w-4 shrink-0 min-[1800px]:w-8", done ? "bg-emerald-300" : "bg-slate-200")} />}
          </div>
        );
      })}
    </nav>
  );
}
