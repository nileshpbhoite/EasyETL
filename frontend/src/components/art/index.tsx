"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

/* Decorative illustrations drawn in SVG so they stay crisp at any size.
   All are aria-hidden: they never carry information on their own. */

type Faces = { top: [string, string]; left: string; right: string };

function Slab({ cx, cy, a, t, faces, id, edge = "#ffffff" }: { cx: number; cy: number; a: number; t: number; faces: Faces; id: string; edge?: string }) {
  const b = a * 0.5;
  const top = `${cx},${cy - b} ${cx + a},${cy} ${cx},${cy + b} ${cx - a},${cy}`;
  const left = `${cx - a},${cy} ${cx},${cy + b} ${cx},${cy + b + t} ${cx - a},${cy + t}`;
  const right = `${cx + a},${cy} ${cx},${cy + b} ${cx},${cy + b + t} ${cx + a},${cy + t}`;
  return (
    <g>
      <defs>
        <linearGradient id={`${id}-t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={faces.top[0]} />
          <stop offset="1" stopColor={faces.top[1]} />
        </linearGradient>
      </defs>
      <polygon points={left} fill={faces.left} />
      <polygon points={right} fill={faces.right} />
      <polygon points={top} fill={`url(#${id}-t)`} />
      <polyline points={`${cx - a},${cy} ${cx},${cy + b} ${cx + a},${cy}`} fill="none" stroke={edge} strokeOpacity=".75" strokeWidth="1.3" />
      <polyline points={`${cx},${cy + b} ${cx},${cy + b + t}`} fill="none" stroke={edge} strokeOpacity=".5" strokeWidth="1" />
      <polygon points={top} fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1" />
    </g>
  );
}

const SLABS: Faces[] = [
  { top: ["#b9ccff", "#6f8cff"], left: "#4d63f0", right: "#3a47c9" },
  { top: ["#d9ccff", "#9a86ff"], left: "#7a63f3", right: "#5a45cf" },
  { top: ["#eef3ff", "#a9c2ff"], left: "#7e9dff", right: "#5b76e6" },
];

/** Three stacked Bronze/Silver/Gold-style layers with a glowing cube on top. */
function Stack({ cx, cy, a, id }: { cx: number; cy: number; a: number; id: string }) {
  const t = a * 0.22;
  const gap = a * 0.34;
  return (
    <g>
      <ellipse cx={cx} cy={cy + gap * 2 + a * 0.62} rx={a * 1.25} ry={a * 0.42} fill={`url(#${id}-glow)`} />
      {SLABS.map((f, i) => (
        <g key={i}>
          <ellipse cx={cx} cy={cy + gap * (2 - i) + a * 0.5 + t * 0.6} rx={a * 0.95} ry={a * 0.34} fill="#7dd3fc" opacity=".35" filter={`url(#${id}-blur)`} />
          <Slab cx={cx} cy={cy + gap * (2 - i)} a={a} t={t} faces={f} id={`${id}-s${i}`} edge={i === 1 ? "#e9d5ff" : "#bae6fd"} />
        </g>
      ))}
      <ellipse cx={cx} cy={cy - a * 0.05} rx={a * 0.42} ry={a * 0.2} fill="#a5f3fc" opacity=".8" filter={`url(#${id}-blur)`} />
      <Slab cx={cx} cy={cy - a * 0.28} a={a * 0.26} t={a * 0.26} faces={{ top: ["#ffffff", "#c7f0ff"], left: "#7fb4ff", right: "#5b8cf0" }} id={`${id}-cube`} />
    </g>
  );
}

function Defs({ id }: { id: string }) {
  return (
    <defs>
      <radialGradient id={`${id}-glow`}>
        <stop offset="0" stopColor="#8b9cff" stopOpacity=".55" />
        <stop offset="1" stopColor="#8b9cff" stopOpacity="0" />
      </radialGradient>
      <filter id={`${id}-blur`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="8" />
      </filter>
    </defs>
  );
}

/** Home hero: snowy mountains with the lakehouse stack. */
export function HeroArt({ className }: { className?: string }) {
  const id = `h${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 640 340" className={cn("pointer-events-none select-none", className)} aria-hidden>
      <Defs id={id} />
      <defs>
        <linearGradient id={`${id}-m1`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e4e8ff" />
          <stop offset="1" stopColor="#f3f1ff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-m2`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".55" stopColor="#dfe5ff" />
          <stop offset="1" stopColor="#eef0ff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-sh`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b8c3f5" />
          <stop offset="1" stopColor="#d9dcff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* distant range */}
      <path d="M0 250 L90 170 L150 205 L240 110 L320 175 L380 140 L470 200 L560 130 L640 190 L640 340 L0 340Z" fill={`url(#${id}-m1)`} />
      {/* main peak */}
      <path d="M150 300 L300 60 L360 130 L400 100 L560 300Z" fill={`url(#${id}-m2)`} />
      <path d="M300 60 L330 150 L300 230 L360 300 L560 300 L400 100 L360 130Z" fill={`url(#${id}-sh)`} opacity=".7" />
      <path d="M300 60 L285 110 L300 100 L312 125 L322 95Z" fill="#fff" />
      {/* pine trees */}
      {[[170, 292, 16], [188, 298, 20], [206, 290, 14], [222, 300, 22], [520, 296, 18], [540, 300, 14], [556, 292, 20]].map(([x, y, h], i) => (
        <path key={i} d={`M${x} ${y - h} L${x + h * 0.35} ${y} L${x - h * 0.35} ${y}Z`} fill="#7c8fd6" opacity=".55" />
      ))}
      <Stack cx={450} cy={120} a={92} id={id} />
    </svg>
  );
}

/** Page header art: the stack with source files flowing into it. */
export function FlowArt({ className }: { className?: string }) {
  const id = `f${useId().replace(/:/g, "")}`;
  const tile = (x: number, y: number, color: string, label: string, r = 0) => (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <rect width="34" height="40" rx="7" fill="#fff" opacity=".9" />
      <rect x="4" y="4" width="26" height="32" rx="5" fill={color} />
      <text x="17" y="25" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="Inter, sans-serif">{label}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 420 210" className={cn("pointer-events-none select-none", className)} aria-hidden>
      <Defs id={id} />
      <g fill="none" stroke="#a78bfa" strokeWidth="2" strokeDasharray="2 5" strokeLinecap="round" opacity=".8">
        <path d="M60 60 C120 60 150 110 210 110" />
        <path d="M70 150 C130 150 160 125 210 122" />
        <path d="M350 40 C320 60 300 80 270 95" />
        <path d="M370 150 C330 150 310 135 275 128" />
      </g>
      {tile(28, 38, "#16a34a", "X", -8)}
      {tile(40, 128, "#6366f1", "{ }", 6)}
      {tile(340, 18, "#0ea5e9", "</>", 8)}
      {tile(352, 128, "#8b5cf6", "▦", -6)}
      <Stack cx={240} cy={62} a={66} id={id} />
    </svg>
  );
}

/** Friendly AI assistant mascot. */
export function Robot({ size = 72, className }: { size?: number; className?: string }) {
  const id = `r${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" className={cn("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dfe4ff" />
        </linearGradient>
        <linearGradient id={`${id}-v`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#26336e" />
          <stop offset="1" stopColor="#0f1638" />
        </linearGradient>
        <radialGradient id={`${id}-e`}>
          <stop offset="0" stopColor="#e0fbff" />
          <stop offset=".45" stopColor="#5ee7ff" />
          <stop offset="1" stopColor="#3b82f6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="60" cy="112" rx="30" ry="5" fill="#6366f1" opacity=".15" />
      {/* body */}
      <path d="M36 84 Q60 70 84 84 L80 104 Q60 112 40 104Z" fill={`url(#${id}-h)`} stroke="#c7cdfa" />
      <circle cx="60" cy="92" r="5" fill="#8b5cf6" />
      <circle cx="60" cy="92" r="9" fill="#8b5cf6" opacity=".2" />
      {/* arms */}
      <path d="M34 86 Q20 78 22 64" stroke="#dfe4ff" strokeWidth="8" strokeLinecap="round" fill="none" />
      <circle cx="22" cy="62" r="6" fill="#fff" stroke="#c7cdfa" />
      {/* antenna */}
      <path d="M60 18 V8" stroke="#a5b4fc" strokeWidth="3" strokeLinecap="round" />
      <circle cx="60" cy="7" r="5" fill="#8b5cf6" />
      <circle cx="60" cy="7" r="9" fill="#8b5cf6" opacity=".25" />
      {/* ears */}
      <rect x="18" y="40" width="10" height="22" rx="5" fill="#c7d2fe" />
      <rect x="92" y="40" width="10" height="22" rx="5" fill="#c7d2fe" />
      {/* head */}
      <rect x="24" y="18" width="72" height="58" rx="26" fill={`url(#${id}-h)`} stroke="#c7cdfa" />
      <rect x="32" y="30" width="56" height="34" rx="17" fill={`url(#${id}-v)`} />
      <ellipse cx="48" cy="47" rx="9" ry="10" fill={`url(#${id}-e)`} />
      <ellipse cx="72" cy="47" rx="9" ry="10" fill={`url(#${id}-e)`} />
      <ellipse cx="48" cy="47" rx="3.5" ry="4.5" fill="#fff" />
      <ellipse cx="72" cy="47" rx="3.5" ry="4.5" fill="#fff" />
      <path d="M38 26 Q50 21 62 23" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity=".9" fill="none" />
    </svg>
  );
}

/** Faceted crystal used on "ready" call-to-action bars. */
export function Gem({ size = 56, className }: { size?: number; className?: string }) {
  const id = `g${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cn("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c4b5fd" /><stop offset="1" stopColor="#6366f1" /></linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a5f3fc" /><stop offset="1" stopColor="#3b82f6" /></linearGradient>
        <linearGradient id={`${id}-c`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f5d0fe" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient>
        <filter id={`${id}-f`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      <circle cx="32" cy="34" r="20" fill="#8b5cf6" opacity=".35" filter={`url(#${id}-f)`} />
      <polygon points="32,4 54,20 32,26 10,20" fill={`url(#${id}-b)`} />
      <polygon points="10,20 32,26 32,60" fill={`url(#${id}-a)`} />
      <polygon points="54,20 32,26 32,60" fill={`url(#${id}-c)`} />
      <polygon points="32,4 42,19 32,26 22,19" fill="#fff" opacity=".45" />
      <polyline points="10,20 32,26 54,20" fill="none" stroke="#fff" strokeOpacity=".7" />
    </svg>
  );
}

/** Small version of the layer stack for tiles. */
export function MiniStack({ className }: { className?: string }) {
  const id = `m${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 90 70" className={cn("pointer-events-none select-none", className)} aria-hidden>
      <Defs id={id} />
      <Stack cx={45} cy={16} a={26} id={id} />
    </svg>
  );
}
