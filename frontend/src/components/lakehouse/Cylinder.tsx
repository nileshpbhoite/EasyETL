import { useId } from "react";

const COLORS = {
  bronze: ["#f7a35c", "#e0782f", "#c2611f"],
  silver: ["#cfd8e3", "#9fb0c3", "#7d8fa5"],
  gold: ["#ffd45c", "#f5b50f", "#d99a00"],
  blue: ["#8fb2ff", "#3b6ef6", "#2659eb"],
} as const;

/** 3D database cylinder used for medallion layers. */
export function Cylinder({ layer, size = 44 }: { layer: keyof typeof COLORS; size?: number }) {
  const [top, mid, dark] = COLORS[layer];
  const id = `cyl-${layer}${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor={dark} />
          <stop offset=".45" stopColor={mid} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
      </defs>
      <path d="M8 11v26c0 3.9 7.2 7 16 7s16-3.1 16-7V11" fill={`url(#${id})`} />
      <path d="M8 20c0 3.9 7.2 7 16 7s16-3.1 16-7M8 29c0 3.9 7.2 7 16 7s16-3.1 16-7" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="1.2" />
      <ellipse cx="24" cy="11" rx="16" ry="7" fill={top} />
      <ellipse cx="24" cy="11" rx="16" ry="7" fill="none" stroke="#fff" strokeOpacity=".4" />
    </svg>
  );
}
