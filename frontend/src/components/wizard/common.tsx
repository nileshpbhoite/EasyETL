"use client";

import { ArrowLeft, ArrowRight, Check, CircleHelp, Boxes, Cloud, Database, FileUp, Globe, HardDrive, LifeBuoy, Megaphone, Server, Share2, Snowflake, Users } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { Button, Tooltip } from "@/components/ui";
import { cn } from "@/lib/utils";

export function StepHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-brand-600">{eyebrow}</div>}
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h2>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Where the user is in the wizard; lets the footer show progress without prop drilling. */
export const WizardStepContext = createContext<{ index: number; total: number; label: string } | null>(null);

export function WizardFooter({ onBack, backLabel = "Back", primary, secondary, note }: { onBack?: () => void; backLabel?: string; primary?: ReactNode; secondary?: ReactNode; note?: ReactNode }) {
  const ctx = useContext(WizardStepContext);
  return (
    <div className="sticky bottom-3 z-10 mt-6 flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white/90 px-3 py-2.5 shadow-[0_12px_32px_-12px_rgb(15_23_42_/_0.25)] backdrop-blur-md">
      {onBack && (
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> {backLabel}
        </Button>
      )}
      {ctx && (
        <div className="hidden items-center gap-3 sm:flex">
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-brand-500 transition-all duration-500" style={{ width: `${((ctx.index + 1) / ctx.total) * 100}%` }} />
          </div>
          <span className="whitespace-nowrap text-[12.5px] font-medium text-slate-500">Step {ctx.index + 1} of {ctx.total}</span>
        </div>
      )}
      {note && <div className="truncate text-sm text-slate-500">{note}</div>}
      <div className="ml-auto flex items-center gap-2">
        {secondary}
        {primary}
      </div>
    </div>
  );
}

/** Card with the numbered header used throughout the wizard ("1  Select Source"). */
export function SectionCard({ n, title, subtitle, actions, children, className, bodyClassName, help }: {
  n?: number | string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  help?: ReactNode;
}) {
  return (
    <section className={cn("rounded-2xl border border-slate-200/60 bg-white shadow-card", className)}>
      <header className="flex items-start gap-3 px-6 pb-4 pt-5">
        {n !== undefined && <span className="step-badge font-display flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white">{n}</span>}
        <div className="min-w-0 flex-1">
          <h3 className="text-[18px] font-bold leading-tight text-slate-900">{title}</h3>
          {subtitle && <p className="mt-1 text-[13.5px] leading-snug text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        {help && (
          <Tooltip content={help}>
            <button type="button" className="mt-0.5 text-slate-400 hover:text-slate-600" aria-label="Help"><CircleHelp className="size-[18px]" /></button>
          </Tooltip>
        )}
      </header>
      <div className={cn("px-6 pb-6", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Underlined text tabs used inside cards. */
export function LineTabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cn("flex gap-1 overflow-x-auto border-b border-slate-200 scrollbar-thin", className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cn("-mb-px shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[13.5px] font-semibold transition-colors", value === t.value ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Pill tabs (Data Preview | Transform | …). */
export function PillTabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cn("rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-all", value === t.value ? "bg-brand-600 text-white shadow-[0_6px_14px_-6px_rgb(38_89_235)]" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CheckItem({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "blue" }) {
  return (
    <li className="flex gap-2.5 text-[13px] text-slate-700">
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-white", tone === "green" ? "bg-emerald-500" : "bg-brand-600")}>
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
      <span>{children}</span>
    </li>
  );
}

export function NextButton({ children, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button variant="primary" size="lg" {...props}>
      {children} <ArrowRight />
    </Button>
  );
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  upload: FileUp, cloud: Cloud, boxes: Boxes, "life-buoy": LifeBuoy, users: Users, snowflake: Snowflake, megaphone: Megaphone,
  server: Server, database: Database, "hard-drive": HardDrive, globe: Globe, share2: Share2,
};

export function ConnectorIcon({ icon, color, size = "md", className }: { icon: string; color: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const Icon = ICONS[icon] ?? Database;
  const box = { sm: "size-7 rounded-md", md: "size-10 rounded-xl", lg: "size-12 rounded-xl" }[size];
  const ic = { sm: "size-3.5", md: "size-5", lg: "size-6" }[size];
  return (
    <div className={cn("flex shrink-0 items-center justify-center text-white shadow-sm", box, className)} style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}>
      <Icon className={ic} />
    </div>
  );
}
