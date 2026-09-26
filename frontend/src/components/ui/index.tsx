"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronDown, CircleAlert, Info, LoaderCircle, Plus, Sparkles, Trash2, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import type { ApiError } from "@/lib/api";

// ------------------------------------------------------------------ Button
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "gradient-primary text-white shadow-glow hover:brightness-110 active:brightness-95",
        secondary: "bg-white text-slate-700 border border-slate-200 shadow-sm hover:bg-slate-50 hover:border-slate-300 hover:text-slate-900",
        ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
        ai: "bg-ai-600 text-white hover:bg-ai-700 shadow-[0_8px_24px_-10px_rgb(124_58_237_/_0.7)]",
        aiSoft: "bg-ai-50 text-ai-700 border border-ai-200 hover:bg-ai-100",
        danger: "bg-rose-600 text-white hover:bg-rose-700",
        dangerSoft: "text-rose-600 hover:bg-rose-50",
        databricks: "bg-dbx-500 text-white hover:bg-dbx-600 shadow-[0_8px_24px_-10px_rgb(255_54_33_/_0.7)]",
        link: "text-brand-600 hover:text-brand-700 underline-offset-4 hover:underline px-0",
      },
      size: { sm: "h-8 rounded-lg px-3 text-xs", md: "h-10 px-4", lg: "h-11 px-6 text-[15px]", icon: "h-9 w-9" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {loading && <LoaderCircle className="animate-spin" />}
    {children}
  </button>
));
Button.displayName = "Button";

// ------------------------------------------------------------------ Card
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-2xl border border-slate-200/60 bg-white shadow-card", className)} {...props} />;
}

export function CardHeader({ title, description, icon, actions, className }: { title: React.ReactNode; description?: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4", className)}>
      <div className="flex items-start gap-3 min-w-0">
        {icon && <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 [&_svg]:size-4">{icon}</div>}
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Badge
const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium [&_svg]:size-3", {
  variants: {
    tone: {
      slate: "bg-slate-100 text-slate-600",
      brand: "bg-brand-50 text-brand-700",
      ai: "bg-ai-50 text-ai-700 ring-1 ring-inset ring-ai-200",
      green: "bg-emerald-50 text-emerald-700",
      amber: "bg-amber-50 text-amber-700",
      red: "bg-rose-50 text-rose-700",
      sky: "bg-sky-50 text-sky-700",
      dbx: "bg-orange-50 text-dbx-600",
      bronze: "bg-orange-100 text-orange-800",
      silver: "bg-slate-200 text-slate-700",
      gold: "bg-amber-100 text-amber-800",
    },
  },
  defaultVariants: { tone: "slate" },
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function AIBadge({ label = "AI", className }: { label?: string; className?: string }) {
  return (
    <Badge tone="ai" className={className}>
      <Sparkles /> {label}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: VariantProps<typeof badgeVariants>["tone"]; label: string; dot: string }> = {
    running: { tone: "green", label: "Running", dot: "bg-emerald-500" },
    succeeded: { tone: "green", label: "Succeeded", dot: "bg-emerald-500" },
    deployed: { tone: "green", label: "Deployed", dot: "bg-emerald-500" },
    ready: { tone: "brand", label: "Ready", dot: "bg-brand-500" },
    draft: { tone: "slate", label: "Draft", dot: "bg-slate-400" },
    paused: { tone: "amber", label: "Paused", dot: "bg-amber-500" },
    failed: { tone: "red", label: "Failed", dot: "bg-rose-500" },
    not_deployed: { tone: "slate", label: "Not deployed", dot: "bg-slate-400" },
    deploying: { tone: "sky", label: "Deploying", dot: "bg-sky-500" },
  };
  const s = map[status] ?? { tone: "slate", label: status, dot: "bg-slate-400" };
  return (
    <Badge tone={s.tone}>
      <span className={cn("size-1.5 rounded-full", s.dot, status === "running" && "animate-pulse-soft")} />
      {s.label}
    </Badge>
  );
}

// ------------------------------------------------------------------ Inputs
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-10 w-full rounded-xl border border-slate-200 bg-white px-3.5 text-sm text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn("w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export function Select({ value, onChange, options, placeholder, className, disabled }: {
  value: string | undefined | null;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-sm text-slate-800 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

export function Label({ children, hint, required, className }: { children: React.ReactNode; hint?: React.ReactNode; required?: boolean; className?: string }) {
  return (
    <div className={cn("mb-1.5 flex items-center gap-1.5", className)}>
      <span className="text-xs font-medium text-slate-700">
        {children}
        {required && <span className="text-rose-500"> *</span>}
      </span>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

export function Field({ label, hint, help, required, children, className }: { label: React.ReactNode; hint?: React.ReactNode; help?: React.ReactNode; required?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label hint={hint} required={required}>
        {label}
      </Label>
      {children}
      {help && <p className="mt-1 text-xs text-slate-500">{help}</p>}
    </div>
  );
}

export function Switch({ checked, onCheckedChange, disabled, label, description, tone = "brand" }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; label?: React.ReactNode; description?: React.ReactNode; tone?: "brand" | "green" }) {
  const control = (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn("relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-slate-200 transition-colors disabled:opacity-50", tone === "green" ? "data-[state=checked]:bg-emerald-500" : "data-[state=checked]:bg-brand-600")}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
  if (!label) return control;
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <div>
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {description && <div className="text-xs text-slate-500">{description}</div>}
      </div>
      {control}
    </label>
  );
}

export function Checkbox({ checked, onChange, disabled, className, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; className?: string; indeterminate?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked || indeterminate ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white hover:border-brand-400",
        disabled && "opacity-50",
        className,
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
      {!checked && indeterminate && <span className="h-0.5 w-2 rounded bg-white" />}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className, size = "md" }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[]; className?: string; size?: "sm" | "md" }) {
  return (
    <div className={cn("inline-flex rounded-xl bg-slate-100/80 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg font-medium transition-all [&_svg]:size-3.5",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
            value === o.value ? "bg-white text-brand-700 shadow-sm ring-1 ring-slate-200/70" : "text-slate-500 hover:text-slate-700",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Tabs
export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex gap-1 border-b border-slate-200", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-slate-800 data-[state=active]:border-brand-600 data-[state=active]:text-brand-700 [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}
export const TabsContent = TabsPrimitive.Content;

// ------------------------------------------------------------------ Dialog
export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md" }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const w = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-6xl" }[size];
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-navy-950/40 backdrop-blur-[2px] animate-fade-in" />
        <DialogPrimitive.Content className={cn("fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white shadow-2xl animate-slide-up", w)}>
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold text-slate-900">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-1 text-sm text-slate-500">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{String(title)}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", onConfirm, destructive, loading }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  destructive?: boolean;
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-600">{description}</div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Tooltip / hint
export function Tooltip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-lg bg-navy-900 px-3 py-2 text-xs leading-relaxed text-white shadow-lg animate-fade-in">
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip content={children}>
      <button type="button" className="text-slate-400 hover:text-slate-600" aria-label="More information">
        <Info className="size-3.5" />
      </button>
    </Tooltip>
  );
}

// ------------------------------------------------------------------ Feedback
export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn("size-4 animate-spin text-brand-600", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} />;
}

export function Progress({ value, className, tone = "brand" }: { value: number; className?: string; tone?: "brand" | "green" | "amber" | "red" | "ai" }) {
  const color = { brand: "gradient-primary", green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-rose-500", ai: "gradient-ai" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-slate-100", className)}>
      <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-50 to-ai-50 text-brand-600 ring-1 ring-brand-100 [&_svg]:size-6">{icon}</div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error, className, onRetry }: { error: ApiError | Error | null | undefined; className?: string; onRetry?: () => void }) {
  const [show, setShow] = React.useState(false);
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className={cn("rounded-xl border border-rose-200 bg-rose-50/70 p-4", className)}>
      <div className="flex gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-rose-500" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-rose-900">{e.title ?? "Something went wrong"}</div>
          <div className="mt-0.5 text-sm text-rose-800/90">{e.message}</div>
          <div className="mt-2 flex items-center gap-3">
            {onRetry && (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            )}
            {e.technical && (
              <button className="text-xs font-medium text-rose-700 hover:underline" onClick={() => setShow((v) => !v)}>
                {show ? "Hide" : "Show"} technical details
              </button>
            )}
          </div>
          {show && e.technical && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-white/70 p-2 font-mono text-[11px] text-rose-900">{e.technical}</pre>}
        </div>
      </div>
    </div>
  );
}

export function Callout({ tone = "info", title, children, icon, action, className }: { tone?: "info" | "ai" | "warning" | "success" | "danger"; title?: React.ReactNode; children?: React.ReactNode; icon?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  const styles = {
    info: "border-sky-200 bg-sky-50/70 text-sky-900",
    ai: "border-ai-200 ai-surface text-ai-900",
    warning: "border-amber-200 bg-amber-50/80 text-amber-900",
    success: "border-emerald-200 bg-emerald-50/80 text-emerald-900",
    danger: "border-rose-200 bg-rose-50/80 text-rose-900",
  }[tone];
  return (
    <div className={cn("flex gap-3 rounded-xl border p-4", styles, className)}>
      {icon && <div className="mt-0.5 shrink-0 [&_svg]:size-5">{icon}</div>}
      <div className="min-w-0 flex-1 text-sm">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && "mt-0.5", "opacity-90")}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, icon, tone = "brand", className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: React.ReactNode; tone?: "brand" | "green" | "amber" | "red" | "ai" | "sky" | "slate"; className?: string }) {
  const iconTone = { brand: "bg-brand-50 text-brand-600", green: "bg-emerald-50 text-emerald-600", amber: "bg-amber-50 text-amber-600", red: "bg-rose-50 text-rose-600", ai: "bg-ai-50 text-ai-600", sky: "bg-sky-50 text-sky-600", slate: "bg-slate-100 text-slate-600" }[tone];
  return (
    <Card className={cn("p-4", className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-slate-500">{label}</div>
        {icon && <div className={cn("flex size-7 items-center justify-center rounded-lg [&_svg]:size-4", iconTone)}>{icon}</div>}
      </div>
      <div className="font-display mt-2 text-2xl font-bold tracking-tight text-slate-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </Card>
  );
}

export function KeyValueEditor({ value, onChange, keyPlaceholder = "Key", valuePlaceholder = "Value" }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; keyPlaceholder?: string; valuePlaceholder?: string }) {
  const entries = Object.entries(value ?? {});
  const [draft, setDraft] = React.useState<[string, string]>(["", ""]);
  const update = (i: number, k: string, v: string) => {
    const next = entries.map((e, j) => (j === i ? [k, v] : e));
    onChange(Object.fromEntries(next));
  };
  return (
    <div className="space-y-2">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex gap-2">
          <Input value={k} onChange={(e) => update(i, e.target.value, v)} placeholder={keyPlaceholder} />
          <Input value={String(v ?? "")} onChange={(e) => update(i, k, e.target.value)} placeholder={valuePlaceholder} />
          <Button variant="ghost" size="icon" onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))} aria-label="Remove">
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input value={draft[0]} onChange={(e) => setDraft([e.target.value, draft[1]])} placeholder={keyPlaceholder} />
        <Input value={draft[1]} onChange={(e) => setDraft([draft[0], e.target.value])} placeholder={valuePlaceholder} />
        <Button
          variant="secondary"
          size="icon"
          aria-label="Add"
          disabled={!draft[0]}
          onClick={() => {
            onChange({ ...(value ?? {}), [draft[0]]: draft[1] });
            setDraft(["", ""]);
          }}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

export function ScoreRing({ score, size = 64, label }: { score: number | null | undefined; size?: number; label?: string }) {
  const s = score ?? 0;
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const color = s >= 90 ? "#10b981" : s >= 75 ? "#f59e0b" : "#f43f5e";
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#eef0f5" strokeWidth={6} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={6} fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - s / 100)} strokeLinecap="round" className="transition-all duration-700" />
      </svg>
      <div className="absolute text-center">
        <div className="text-sm font-semibold text-slate-900">{score === null || score === undefined ? "—" : `${Math.round(s)}%`}</div>
        {label && <div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div>}
      </div>
    </div>
  );
}
