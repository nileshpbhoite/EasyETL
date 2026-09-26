"use client";

import { ArrowLeft, ArrowRight, Boxes, Cloud, Database, FileUp, Globe, HardDrive, LifeBuoy, Megaphone, Server, Share2, Snowflake, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui";
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

export function WizardFooter({ onBack, backLabel = "Back", primary, secondary, note }: { onBack?: () => void; backLabel?: string; primary?: ReactNode; secondary?: ReactNode; note?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-6 mt-8 border-t border-slate-200 bg-white/90 px-6 py-3 backdrop-blur md:-mx-8 md:px-8">
      <div className="flex items-center gap-3">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft /> {backLabel}
          </Button>
        )}
        {note && <div className="text-sm text-slate-500">{note}</div>}
        <div className="ml-auto flex items-center gap-2">
          {secondary}
          {primary}
        </div>
      </div>
    </div>
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
