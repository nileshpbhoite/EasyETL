"use client";

import { ArrowRight, CircleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { DataGrid } from "@/components/data/DataGrid";
import { Segmented } from "@/components/ui";
import type { Preview, PreviewMetrics } from "@/lib/types";
import { cn, fmtNumber } from "@/lib/utils";

function Metric({ label, before, after, better, fmt = (v) => fmtNumber(v), suffix = "" }: { label: string; before: number; after: number; better: "up" | "down" | "none"; fmt?: (v: number) => string; suffix?: string }) {
  const diff = after - before;
  const good = better === "none" || diff === 0 ? null : (better === "up") === diff > 0;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-sm">
        <span className="tabular-nums text-slate-500">{fmt(before)}{suffix}</span>
        <ArrowRight className="size-3 text-slate-300" />
        <span className={cn("font-semibold tabular-nums", good === true ? "text-emerald-600" : good === false ? "text-rose-600" : "text-slate-900")}>{fmt(after)}{suffix}</span>
      </div>
    </div>
  );
}

export function MetricsCompare({ before, after }: { before: PreviewMetrics; after: PreviewMetrics }) {
  return (
    <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
      <div className="col-span-3 flex items-center gap-4 rounded-lg bg-gradient-to-r from-brand-50 to-ai-50 px-4 py-2 ring-1 ring-brand-100 lg:col-span-1 lg:flex-col lg:items-start lg:gap-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">Data Quality</div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm text-slate-500">{before.quality_score}%</span>
          <ArrowRight className="size-3 text-slate-400" />
          <span className={cn("text-xl font-bold", after.quality_score >= before.quality_score ? "text-emerald-600" : "text-rose-600")}>{after.quality_score}%</span>
        </div>
      </div>
      <Metric label="Rows" before={before.rows} after={after.rows} better="none" />
      <Metric label="Columns" before={before.columns} after={after.columns} better="none" />
      <Metric label="Null cells" before={before.null_pct} after={after.null_pct} better="down" fmt={(v) => v.toFixed(1)} suffix="%" />
      <Metric label="Duplicates" before={before.duplicates} after={after.duplicates} better="down" />
      <Metric label="Invalid values" before={before.invalid_values} after={after.invalid_values} better="down" />
    </div>
  );
}

export function BeforeAfter({ preview, maxHeight = 380 }: { preview: Preview; maxHeight?: number }) {
  const [view, setView] = useState<"split" | "changes">("split");
  const ch = preview.changes;
  const changedSet = useMemo(() => new Set((ch.changed_cells_sample ?? []).map((c) => `${c.row_id}:${c.column}`)), [ch]);
  const removed = useMemo(() => new Set(ch.removed_row_ids), [ch]);
  const changedRows = useMemo(() => new Set(ch.changed_row_ids), [ch]);

  const beforeCols = preview.before.columns.map((c) => ({ ...c, highlight: ch.removed_columns.includes(c.name) ? ("removed" as const) : ch.changed_columns[c.name] ? ("changed" as const) : undefined }));
  const afterCols = preview.after.columns.map((c) => ({ ...c, highlight: ch.added_columns.includes(c.name) ? ("added" as const) : ch.changed_columns[c.name] ? ("changed" as const) : undefined }));
  const filter = (rows: Record<string, any>[]) => (view === "changes" && ch.aligned ? rows.filter((r) => changedRows.has(r.__row_id) || removed.has(r.__row_id)) : rows);
  const afterRows = filter(preview.after.rows).filter((r) => !ch.aligned || !removed.has(r.__row_id));

  const summary = [
    ch.changed_cells ? `${fmtNumber(ch.changed_cells)} cells changed` : null,
    ch.rows_removed ? `${fmtNumber(ch.rows_removed)} rows removed` : null,
    ch.rows_added ? `${fmtNumber(ch.rows_added)} rows added` : null,
    ch.added_columns.length ? `${ch.added_columns.length} column${ch.added_columns.length > 1 ? "s" : ""} added` : null,
    ch.removed_columns.length ? `${ch.removed_columns.length} column${ch.removed_columns.length > 1 ? "s" : ""} removed` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-3">
      {preview.error && (
        <div className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <b>This step can't run yet:</b> {preview.error.message}
            {preview.error.technical && <div className="mt-1 font-mono text-[11px] opacity-70">{preview.error.technical}</div>}
          </div>
        </div>
      )}
      <MetricsCompare before={preview.before.metrics} after={preview.after.metrics} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{summary.length ? summary.join(" · ") : "No visible changes in the sample"}</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-amber-200" /> changed</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-emerald-200" /> added</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-rose-200" /> removed</span>
        </div>
        {ch.aligned && <Segmented size="sm" value={view} onChange={setView} options={[{ value: "split", label: "All sample rows" }, { value: "changes", label: "Changes only" }]} />}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Before <span className="font-normal normal-case text-slate-400">· original data</span></div>
          <DataGrid
            columns={beforeCols}
            rows={filter(preview.before.rows)}
            maxHeight={maxHeight}
            rowClass={(r) => (removed.has(r.__row_id) ? "bg-rose-50/80 [&_td]:text-rose-400 [&_td]:line-through" : undefined)}
            cellClass={(r, c) => (changedSet.has(`${r.__row_id}:${c}`) ? "bg-amber-50/70" : undefined)}
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">After <span className="font-normal normal-case text-slate-400">· transformed data</span></div>
          <DataGrid
            columns={afterCols}
            rows={afterRows}
            maxHeight={maxHeight}
            cellClass={(r, c) => (changedSet.has(`${r.__row_id}:${c}`) ? "bg-amber-100/80 font-semibold text-amber-900" : ch.added_columns.includes(c) ? "bg-emerald-50/80 text-emerald-900" : undefined)}
          />
        </div>
      </div>
    </div>
  );
}
