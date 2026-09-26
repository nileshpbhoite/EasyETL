"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

const TONES = {
  blue: ["#a5b4fc", "#4f6bff"],
  violet: ["#d8b4fe", "#8b5cf6"],
  green: ["#86efac", "#10b981"],
  red: ["#fda4af", "#f43f5e"],
  amber: ["#fcd34d", "#f59e0b"],
  sky: ["#a5f3fc", "#0ea5e9"],
} as const;
export type Tone = keyof typeof TONES;

/** Small bar chart for KPI tiles. Bars start at zero so heights compare honestly. */
export function SparkBars({ data, tone = "blue", labels, format = String, className, width = 72, height = 36 }: {
  data: number[];
  tone?: Tone;
  labels?: string[];
  format?: (v: number) => string;
  className?: string;
  width?: number;
  height?: number;
}) {
  const id = `sb${useId().replace(/:/g, "")}`;
  const max = Math.max(...data, 0) || 1;
  const n = data.length || 1;
  const gap = 3;
  const bw = (width - gap * (n - 1)) / n;
  const [light, strong] = TONES[tone];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("shrink-0 overflow-visible", className)} role="img" aria-label={`Last ${n} days: ${data.map(format).join(", ")}`}>
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={strong} />
        </linearGradient>
      </defs>
      {data.map((v, i) => {
        const h = Math.max((v / max) * height, v > 0 ? 3 : 1.5);
        return (
          <rect key={i} x={i * (bw + gap)} y={height - h} width={bw} height={h} rx={Math.min(2, bw / 2)} fill={v > 0 ? `url(#${id})` : "#e2e8f0"} opacity={i === n - 1 ? 1 : 0.8}>
            <title>{`${labels?.[i] ?? `Day ${i + 1}`}: ${format(v)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function qualityTone(v: number | null | undefined): Tone {
  if (v == null) return "blue";
  return v >= 90 ? "green" : v >= 75 ? "amber" : "red";
}

/** Donut ring for a single percentage. */
export function Ring({ value, size = 28, stroke = 4, tone, label, className }: { value: number | null | undefined; size?: number; stroke?: number; tone?: Tone; label?: React.ReactNode; className?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const color = TONES[tone ?? qualityTone(value)][1];
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e6e8f6" strokeWidth={stroke} />
        {value != null && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} />}
      </svg>
      {label != null && <span className="absolute inset-0 flex items-center justify-center">{label}</span>}
    </span>
  );
}

/** Donut with several segments (e.g. quality dimensions). */
export function SegmentDonut({ segments, size = 96, stroke = 12, center }: { segments: { value: number; color: string; label: string }[]; size?: number; stroke?: number; center?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let offset = 0;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef0fa" strokeWidth={stroke} />
        {segments.map((s) => {
          const len = (s.value / total) * c;
          const el = <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke} strokeDasharray={`${Math.max(len - 2, 0)} ${c}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        })}
      </svg>
      {center && <span className="absolute inset-0 flex items-center justify-center">{center}</span>}
    </span>
  );
}

export interface Trend {
  series: number[];
  change: number;
  unit: "pct" | "pts" | "abs";
  better: "up" | "down";
}

/** Week-over-week change chip: arrow + value; green when it moved the good way. */
export function TrendChip({ trend, className }: { trend?: Trend | null; className?: string }) {
  if (!trend) return null;
  const { change, unit, better } = trend;
  const flat = Math.abs(change) < (unit === "pct" ? 0.5 : 0.05);
  const good = flat ? null : (change > 0) === (better === "up");
  const v = Math.abs(change);
  const text = unit === "pct" ? `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%` : unit === "pts" ? `${v.toFixed(1)} pts` : `${v}`;
  return (
    <span
      title="Compared with the previous 7 days"
      className={cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold", flat ? "bg-slate-100 text-slate-500" : good ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600", className)}
    >
      {flat ? "→" : change > 0 ? "↑" : "↓"} {flat ? "flat" : text}
    </span>
  );
}

export function KpiTile({ icon, iconClass, label, value, trend, tone = "blue", format, labels, className }: {
  icon: React.ReactNode;
  iconClass: string;
  label: string;
  value: React.ReactNode;
  trend?: Trend | null;
  tone?: Tone;
  format?: (v: number) => string;
  labels?: string[];
  className?: string;
}) {
  return (
    <div className={cn("glass rounded-[18px] p-4", className)}>
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl [&_svg]:size-[18px]", iconClass)}>{icon}</span>
        <span className="text-[12.5px] font-medium leading-tight text-slate-600">{label}</span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="font-display whitespace-nowrap text-[26px] font-bold leading-none text-slate-900">{value}</div>
          {trend && <TrendChip trend={trend} className="mt-2" />}
        </div>
        {trend && <SparkBars data={trend.series} tone={tone} format={format} labels={labels} width={56} height={38} />}
      </div>
    </div>
  );
}
