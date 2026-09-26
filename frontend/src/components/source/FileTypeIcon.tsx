import { cn } from "@/lib/utils";

const TYPES: Record<string, { color: string; label: string }> = {
  xlsx: { color: "#1d8f4e", label: "X" }, excel: { color: "#1d8f4e", label: "X" }, csv: { color: "#16a34a", label: "CSV" },
  json: { color: "#7c3aed", label: "{ }" }, xml: { color: "#ea580c", label: "</>" }, parquet: { color: "#2659eb", label: "PQ" },
  avro: { color: "#0891b2", label: "AV" }, txt: { color: "#64748b", label: "TXT" }, zip: { color: "#475569", label: "ZIP" },
  table: { color: "#0f766e", label: "DB" }, api: { color: "#0ea5e9", label: "API" },
};

/** Document-shaped file badge, e.g. the green Excel icon in the design. */
export function FileTypeIcon({ format, size = 40, className }: { format?: string | null; size?: number; className?: string }) {
  const t = TYPES[(format ?? "").toLowerCase()] ?? TYPES.txt;
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 40 46" className={cn("shrink-0", className)} aria-hidden>
      <path d="M6 1h20l10 10v30a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Z" fill={t.color} />
      <path d="M26 1v7a3 3 0 0 0 3 3h7" fill="#fff" fillOpacity=".35" />
      <text x="19" y="32" textAnchor="middle" fontSize={t.label.length > 2 ? 10 : 14} fontWeight="700" fill="#fff" fontFamily="Inter, system-ui, sans-serif">
        {t.label}
      </text>
    </svg>
  );
}
