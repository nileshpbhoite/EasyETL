"use client";

import { ArrowRight, Check } from "lucide-react";
import { STEPS, type Step } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Stepper({ current, completed, onSelect, deployed }: { current: Step; completed: Step[]; onSelect: (s: Step) => void; deployed: boolean }) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);
  const furthest = Math.max(currentIdx, ...completed.map((c) => STEPS.findIndex((x) => x.id === c)), 0);
  return (
    <nav aria-label="Pipeline steps" className="overflow-x-auto pb-1 scrollbar-thin">
      <ol className="flex min-w-[980px] items-center gap-1">
        {STEPS.map((s, i) => {
          const done = completed.includes(s.id) || (s.id === "monitor" && deployed);
          const active = s.id === current;
          const reachable = i <= furthest + 1;
          return (
            <li key={s.id} className="flex min-w-0 flex-1 items-center gap-0.5">
              <button
                onClick={() => reachable && onSelect(s.id)}
                disabled={!reachable}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-2xl px-2 py-2.5 text-left transition-all",
                  active ? "bg-white shadow-[0_10px_28px_-12px_rgb(91_92_255_/_0.55)] ring-2 ring-brand-300/70" : "glass-soft hover:bg-white/85",
                  !reachable && "cursor-not-allowed opacity-55",
                )}
              >
                <span className="relative shrink-0">
                  <span className={cn("font-display flex size-8 items-center justify-center rounded-full text-[14px] font-bold text-white", reachable ? "step-badge" : "bg-slate-300")}>{i + 1}</span>
                  {done && (
                    <span className="absolute -bottom-0.5 -right-1 flex size-[17px] items-center justify-center rounded-full bg-emerald-500 ring-2 ring-white">
                      <Check className="size-2.5 text-white" strokeWidth={3.5} />
                    </span>
                  )}
                </span>
                <span className="min-w-0 leading-tight">
                  <span className={cn("block truncate text-[13.5px] font-semibold", active ? "text-brand-700" : "text-slate-900")}>{s.label}</span>
                  <span className="block truncate text-[10.5px] text-slate-500" title={s.hint}>{s.hint}</span>
                </span>
              </button>
              {i < STEPS.length - 1 && <ArrowRight className="size-3.5 shrink-0 text-brand-400" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
