"use client";

import { Check } from "lucide-react";
import { STEPS, type Step } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Stepper({ current, completed, onSelect, deployed }: { current: Step; completed: Step[]; onSelect: (s: Step) => void; deployed: boolean }) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);
  const isDone = (id: Step) => completed.includes(id) || (id === "monitor" && deployed);
  const furthest = Math.max(currentIdx, ...completed.map((c) => STEPS.findIndex((x) => x.id === c)), 0);
  return (
    <nav aria-label="Pipeline steps" className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white px-4 pb-3 pt-4 shadow-card scrollbar-thin">
      <ol className="flex min-w-[760px] items-start">
        {STEPS.map((s, i) => {
          const done = isDone(s.id);
          const active = s.id === current;
          const reachable = i <= furthest + 1;
          // The connector to the next step fills once this step is finished.
          const filled = done && (isDone(STEPS[i + 1]?.id) || STEPS[i + 1]?.id === current || i < furthest);
          return (
            <li key={s.id} className="relative flex flex-1 flex-col items-center">
              {i < STEPS.length - 1 && (
                <span aria-hidden className="absolute left-[calc(50%+24px)] right-[calc(-50%+24px)] top-[17px] h-[3px] overflow-hidden rounded-full bg-slate-100">
                  <span className={cn("block h-full rounded-full bg-gradient-to-r from-emerald-400 to-brand-500 transition-all duration-500", filled ? "w-full" : "w-0")} />
                </span>
              )}
              <button
                onClick={() => reachable && onSelect(s.id)}
                disabled={!reachable}
                aria-current={active ? "step" : undefined}
                className={cn("group flex flex-col items-center gap-1.5 rounded-xl px-2 pb-1 text-center outline-none", !reachable && "cursor-not-allowed")}
              >
                <span
                  className={cn(
                    "font-display flex size-9 items-center justify-center rounded-full text-[14px] font-bold transition-all",
                    active
                      ? "step-badge text-white ring-4 ring-brand-100"
                      : done
                        ? "bg-emerald-500 text-white shadow-[0_4px_10px_-4px_rgb(16_185_129)] group-hover:ring-4 group-hover:ring-emerald-100"
                        : reachable
                          ? "border-2 border-slate-200 bg-white text-slate-500 group-hover:border-brand-300 group-hover:text-brand-600"
                          : "border-2 border-slate-100 bg-slate-50 text-slate-300",
                  )}
                >
                  {done && !active ? <Check className="size-4" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn("whitespace-nowrap text-[13px] font-semibold", active ? "text-brand-700" : done ? "text-slate-800" : reachable ? "text-slate-600" : "text-slate-400")}>{s.label}</span>
                <span className={cn("hidden whitespace-nowrap text-[11px] lg:block", active ? "text-brand-500" : "text-slate-400")}>{s.hint}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
