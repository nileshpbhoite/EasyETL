"use client";

import { cn } from "@/lib/utils";

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export interface GridColumn {
  name: string;
  type?: string;
  highlight?: "added" | "changed" | "removed";
}

export function DataGrid({ columns, rows, cellClass, rowClass, maxHeight = 420, className, emptyText = "No rows" }: {
  columns: GridColumn[];
  rows: Record<string, any>[];
  cellClass?: (row: Record<string, any>, col: string) => string | undefined;
  rowClass?: (row: Record<string, any>) => string | undefined;
  maxHeight?: number;
  className?: string;
  emptyText?: string;
}) {
  const cols = columns.filter((c) => c.name !== "__row_id");
  return (
    <div className={cn("overflow-auto rounded-lg border border-slate-200 bg-white scrollbar-thin", className)} style={{ maxHeight }}>
      <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-[1]">
          <tr>
            {cols.map((c) => (
              <th
                key={c.name}
                className={cn(
                  "border-b border-slate-200 bg-slate-50 px-3 py-2 text-left font-semibold text-slate-600 whitespace-nowrap",
                  c.highlight === "added" && "bg-emerald-50 text-emerald-800",
                  c.highlight === "changed" && "bg-amber-50 text-amber-800",
                  c.highlight === "removed" && "bg-rose-50 text-rose-700 line-through",
                )}
              >
                <div>{c.name}</div>
                {c.type && <div className="text-[10px] font-normal text-slate-400">{c.type.replace("String", "text")}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length || 1} className="px-3 py-8 text-center text-slate-400">{emptyText}</td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={r.__row_id ?? i} className={cn("hover:bg-slate-50/60", rowClass?.(r))}>
              {cols.map((c) => {
                const v = r[c.name];
                return (
                  <td key={c.name} className={cn("max-w-[260px] truncate border-b border-slate-100 px-3 py-1.5 font-mono text-[11.5px] text-slate-700", v === null || v === undefined ? "text-slate-300" : "", cellClass?.(r, c.name))} title={formatCell(v)}>
                    {v === null || v === undefined ? "null" : formatCell(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
