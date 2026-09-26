"use client";

import {
  ArrowDown, ArrowLeft, ArrowUp, ChevronRight, CircleCheck, CircleHelp, Copy as CopyIcon, Download, Eye, GripVertical, Lightbulb, Pencil, Plus, RefreshCw,
  Search, ShieldCheck, Sparkles, Trash2, X,
} from "lucide-react";
import { forwardRef, useMemo, useState } from "react";
import { DataGrid, formatCell } from "@/components/data/DataGrid";
import { AIBadge, Badge, Button, Checkbox, ConfirmDialog, Dialog, Input, Spinner, Switch, Tooltip } from "@/components/ui";
import { api } from "@/lib/api";
import { showError } from "@/lib/hooks";
import type { ColumnInfo, Pipeline, Preview, Recommendation, TransformLibrary, TransformSpec, TransformStep } from "@/lib/types";
import { cn, fmtNumber } from "@/lib/utils";
import { LineTabs } from "@/components/wizard/common";
import { BeforeAfter, MetricsCompare } from "./BeforeAfter";
import { CAT_ICON, Fallback, UI_CATS } from "./catalog";
import { ParamForm } from "./ParamForm";

export function Panel({ title, info, actions, children, className, bodyClassName }: { title: React.ReactNode; info?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn("glass flex min-w-0 flex-col rounded-[20px]", className)}>
      <header className="flex items-center gap-2 px-5 pb-3 pt-4">
        <h3 className="text-[15.5px] font-bold text-slate-900">{title}</h3>
        {info && <Tooltip content={info}><CircleHelp className="size-4 text-slate-400" /></Tooltip>}
        {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
      </header>
      <div className={cn("min-h-0 flex-1 px-5 pb-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function StepIcon({ category, className }: { category?: string; className?: string }) {
  const Icon = CAT_ICON[category ?? ""] ?? Fallback;
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600", className)}>
      <Icon className="size-4" />
    </span>
  );
}

// ------------------------------------------------------------------ library
export const Library = forwardRef<HTMLInputElement, { lib: TransformLibrary; onPick: (t: TransformSpec) => void; initialCat?: string | null }>(function Library({ lib, onPick, initialCat }, ref) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(initialCat ?? null);
  const members = (id: string) => {
    const c = UI_CATS.find((x) => x.id === id);
    if (!c) return lib.transforms;
    return lib.transforms.filter((t) => (c.cats ?? []).includes(t.category) || (c.ids ?? []).includes(t.id));
  };
  const term = q.trim().toLowerCase();
  const results = term ? lib.transforms.filter((t) => (t.label + " " + t.description + " " + t.keywords.join(" ")).toLowerCase().includes(term)) : null;
  const list = results ?? (cat === "all" ? lib.transforms : cat ? members(cat) : null);
  const current = UI_CATS.find((c) => c.id === cat);
  return (
    <div className="flex h-full flex-col">
      <div className="relative mb-2">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <Input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search transformations…" className="h-9 pl-8 text-[13px]" />
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 scrollbar-thin">
        {!list ? (
          <>
            <button onClick={() => setCat("all")} className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg bg-brand-50 px-2.5 py-2 text-left text-[13px] font-medium text-brand-700">
              <Sparkles className="size-4" /> All Transformations <span className="ml-auto text-[11px] text-brand-500">{lib.transforms.length}</span>
            </button>
            {UI_CATS.map((c) => (
              <button key={c.id} onClick={() => setCat(c.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-700 hover:bg-slate-50">
                <c.icon className="size-4 text-brand-600" />
                <span className="truncate">{c.label}</span>
                <ChevronRight className="ml-auto size-4 shrink-0 text-slate-400" />
              </button>
            ))}
          </>
        ) : (
          <>
            {!results && (
              <button onClick={() => setCat(null)} className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold text-slate-800 hover:bg-slate-50">
                <ArrowLeft className="size-4 text-slate-400" /> {cat === "all" ? "All Transformations" : current?.label}
              </button>
            )}
            {results && <div className="px-2 pb-1 text-xs text-slate-500">{results.length} result{results.length !== 1 ? "s" : ""}</div>}
            {list.map((t) => (
              <Tooltip key={t.id} content={t.description} side="right">
                <button onClick={() => onPick(t)} className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-700 hover:bg-brand-50 hover:text-brand-700">
                  <StepIcon category={t.category} className="size-6 rounded-md [&_svg]:size-3.5" />
                  <span className="truncate">{t.label}</span>
                  <Plus className="ml-auto size-4 shrink-0 text-brand-500 opacity-0 group-hover:opacity-100" />
                </button>
              </Tooltip>
            ))}
          </>
        )}
      </div>
    </div>
  );
});

// ------------------------------------------------------------------ applied transformations
export function describeParams(step: TransformStep): string {
  const p = step.params ?? {};
  const cols: string[] = p.columns ?? (p.column ? [p.column] : []);
  if (step.type === "convert_types") return (p.conversions ?? []).map((c: { column: string; to: string }) => `${c.column} → ${c.to}`).join(", ");
  if (step.type === "remove_duplicates") return `Remove duplicate rows based on ${cols.join(", ") || "all columns"} (keep ${String(p.keep ?? "first").replace("_", " ")})`;
  if (step.type === "standardize_phone") return `Convert ${p.column} to international format (+15551234567)`;
  if (step.type === "join") return `${String(p.how ?? "left")} join on ${(p.left_on ?? []).join(", ")}`;
  if (step.type === "derive_column" || step.type === "conditional_column" || step.type === "calculate_age") return `New column: ${p.output ?? "age"}`;
  if (step.type === "filter_rows") return `${(p.conditions ?? []).length} condition(s) · ${p.mode === "remove" ? "remove" : "keep"} matching rows`;
  return cols.length ? `Applies to ${cols.slice(0, 4).join(", ")}${cols.length > 4 ? "…" : ""}` : "";
}

export function AppliedList({ steps, lib, selectedId, status, reorderMode, view, onSelect, onToggle, onDelete, onMove, onDrop, onDuplicate, busy, emptyAction }: {
  steps: TransformStep[];
  lib: TransformLibrary;
  selectedId?: string;
  status: Record<string, { status: string; message?: string }>;
  reorderMode: boolean;
  view: "flow" | "table";
  onSelect: (s: TransformStep) => void;
  onToggle: (s: TransformStep) => void;
  onDelete: (s: TransformStep) => void;
  onMove: (i: number, d: number) => void;
  onDrop: (dragId: string, index: number) => void;
  onDuplicate: (s: TransformStep) => void;
  busy: boolean;
  emptyAction?: React.ReactNode;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const spec = (t: string) => lib.transforms.find((x) => x.id === t);
  if (!steps.length)
    return (
      <div className="flex flex-col items-center rounded-2xl border-2 border-dashed border-brand-100 bg-gradient-to-b from-brand-50/40 to-white px-8 py-12 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-ai-500 to-brand-500 text-white shadow-lg"><Sparkles className="size-7" /></span>
        <div className="font-display mt-4 text-[17px] font-bold text-slate-900">Let's clean up your data</div>
        <div className="mt-1 max-w-sm text-[13px] text-slate-500">AI has already found what needs fixing. Apply its suggestions in one click, or pick any transformation from the library on the left.</div>
        {emptyAction && <div className="mt-5 flex flex-wrap justify-center gap-2">{emptyAction}</div>}
      </div>
    );
  if (view === "table")
    return (
      <div className="overflow-auto rounded-xl border border-slate-200 scrollbar-thin">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr><th className="px-3 py-2">#</th><th className="px-3 py-2">Transformation</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Details</th><th className="px-3 py-2">Origin</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">On</th></tr>
          </thead>
          <tbody>
            {steps.map((s, i) => {
              const sp = spec(s.type);
              const st = status[s.id];
              return (
                <tr key={s.id} onClick={() => onSelect(s)} className={cn("cursor-pointer border-t border-slate-100 hover:bg-slate-50", selectedId === s.id && "bg-brand-50/60", !s.enabled && "opacity-50")}>
                  <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                  <td className="px-3 py-2 font-medium text-slate-800">{s.label || sp?.label}</td>
                  <td className="px-3 py-2 text-slate-500">{lib.categories.find((c) => c.id === sp?.category)?.label}</td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-slate-500">{describeParams(s)}</td>
                  <td className="px-3 py-2">{s.origin === "ai" ? <AIBadge /> : <Badge>{s.origin}</Badge>}</td>
                  <td className="px-3 py-2">{st?.status === "error" ? <Badge tone="red">Error</Badge> : st?.status === "ok" ? <Badge tone="green">Valid</Badge> : <Badge>—</Badge>}</td>
                  <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}><Switch tone="green" checked={s.enabled} onCheckedChange={() => onToggle(s)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="space-y-2">
      {steps.map((s, i) => {
        const sp = spec(s.type);
        const st = status[s.id];
        const sel = selectedId === s.id;
        return (
          <div
            key={s.id}
            draggable
            onDragStart={() => setDragId(s.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragId && dragId !== s.id) onDrop(dragId, i); setDragId(null); }}
            onClick={() => onSelect(s)}
            className={cn(
              "group flex cursor-pointer items-center gap-2.5 rounded-xl border bg-white px-2.5 py-2.5 transition-all",
              sel ? "border-brand-400 bg-brand-50/40 shadow-[0_4px_14px_-8px_rgb(38_89_235)]" : "border-slate-200 hover:border-slate-300",
              !s.enabled && "opacity-55",
              st?.status === "error" && "border-rose-200 bg-rose-50/40",
            )}
          >
            <GripVertical className="size-4 shrink-0 cursor-grab text-slate-300" />
            <span className="w-4 shrink-0 text-center text-xs font-medium tabular-nums text-slate-500">{i + 1}</span>
            <StepIcon category={sp?.category} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13.5px] font-semibold text-slate-900">{s.label || sp?.label}</span>
                {s.origin === "ai" && <span className="rounded bg-ai-50 px-1 text-[9px] font-bold text-ai-600 ring-1 ring-ai-200">AI</span>}
              </div>
              <div className={cn("truncate text-[11.5px]", st?.status === "error" ? "text-rose-600" : "text-slate-500")}>{st?.status === "error" ? st.message : describeParams(s) || sp?.description}</div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              {reorderMode ? (
                <>
                  <Button variant="ghost" size="icon" onClick={() => onMove(i, -1)} disabled={i === 0 || busy} aria-label="Move up"><ArrowUp /></Button>
                  <Button variant="ghost" size="icon" onClick={() => onMove(i, 1)} disabled={i === steps.length - 1 || busy} aria-label="Move down"><ArrowDown /></Button>
                </>
              ) : (
                <Switch tone="green" checked={s.enabled} onCheckedChange={() => onToggle(s)} />
              )}
              <Tooltip content="Edit"><Button variant="ghost" size="icon" onClick={() => onSelect(s)} aria-label="Edit"><Pencil /></Button></Tooltip>
              <Tooltip content="Duplicate"><Button variant="ghost" size="icon" className="hidden group-hover:inline-flex" onClick={() => onDuplicate(s)} aria-label="Duplicate"><CopyIcon /></Button></Tooltip>
              <Tooltip content="Delete"><Button variant="ghost" size="icon" className="text-rose-500 hover:bg-rose-50 hover:text-rose-600" onClick={() => onDelete(s)} aria-label="Delete"><Trash2 /></Button></Tooltip>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ settings
export function SettingsPanel({ spec, params, setParams, columns, rightColumns, datasets, lib, datasetId, advanced, mode, onCancel, onSave, onAdd, saving, dirty }: {
  spec: TransformSpec;
  params: Record<string, any>;
  setParams: (p: Record<string, any>) => void;
  columns: ColumnInfo[];
  rightColumns: ColumnInfo[];
  datasets: { id: string; name: string }[];
  lib: TransformLibrary;
  datasetId: string;
  advanced: boolean;
  mode: "draft" | "step";
  onCancel: () => void;
  onSave: () => void;
  onAdd: () => void;
  saving: boolean;
  dirty: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 pb-3">
        <div className="text-[15px] font-semibold text-slate-900">Transformation Settings</div>
        <Tooltip content="Changes are previewed live below before you save them."><CircleHelp className="size-4 text-slate-400" /></Tooltip>
        <button onClick={onCancel} className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close settings"><X className="size-4" /></button>
      </div>
      <div className="flex items-start gap-3 rounded-xl bg-slate-50 p-3">
        <StepIcon category={spec.category} className="size-9" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[14px] font-semibold text-slate-900">{spec.label} {mode === "draft" && <Badge tone="brand">New</Badge>}</div>
          <div className="text-[12px] text-slate-500">{spec.description}</div>
        </div>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
        <ParamForm spec={spec} params={params} setParams={setParams} columns={columns} rightColumns={rightColumns} datasets={datasets} lib={lib} currentDataset={datasetId} advanced={advanced} />
      </div>
      <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {mode === "draft" ? (
          <Button variant="primary" className="ml-auto" onClick={onAdd} loading={saving}><Plus /> Add to pipeline</Button>
        ) : (
          <Button variant="primary" className="ml-auto" onClick={onSave} loading={saving} disabled={!dirty}><CircleCheck /> Save changes</Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ AI recommendations
const PRIORITY = { high: "bg-rose-50 text-rose-600 ring-rose-100", medium: "bg-amber-50 text-amber-600 ring-amber-100", low: "bg-emerald-50 text-emerald-600 ring-emerald-100" };

export function RecsPanel({ pipeline, datasetId, lib, mutate, onRefresh, refreshing }: {
  pipeline: Pipeline;
  datasetId: string;
  lib: TransformLibrary;
  mutate: (label: string, fn: () => Promise<any>, opts?: { success?: string }) => Promise<any>;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const recs = pipeline.metadata.recommendations.filter((r) => r.area === "transformation" && r.dataset_id === datasetId && r.status === "pending");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [explain, setExplain] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [previewRec, setPreviewRec] = useState<Recommendation | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applying, setApplying] = useState(false);
  const isChecked = (r: Recommendation) => checked[r.id] ?? r.preselected;
  const sel = recs.filter(isChecked);
  const catOf = (r: Recommendation) => lib.transforms.find((t) => t.id === r.action.transform?.type)?.category;

  const apply = async (ids: string[]) => {
    setApplying(true);
    await mutate("apply", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/recommendations/apply`, { ids }), { success: `Applied ${ids.length} recommendation${ids.length !== 1 ? "s" : ""}` });
    setApplying(false);
  };
  const openPreview = async (r: Recommendation) => {
    setPreviewRec(r);
    setPreview(null);
    try {
      setPreview(await api.post<Preview>(`/api/pipelines/${pipeline.id}/recommendations/${r.id}/preview`));
    } catch (e) {
      showError(e);
    }
  };

  return (
    <Panel title="AI Recommendations" actions={<Button size="sm" variant="secondary" onClick={onRefresh} loading={refreshing}><RefreshCw /> Refresh</Button>} bodyClassName="flex flex-col">
      <div className="flex items-center gap-3 rounded-xl bg-gradient-to-r from-brand-50 to-ai-50/60 p-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-xl font-semibold text-white shadow-glow">{recs.length}</span>
        <div>
          <div className="text-[14px] font-semibold text-brand-700">{recs.length ? `${recs.length} transformation recommendation${recs.length !== 1 ? "s" : ""}` : "You're up to date"}</div>
          <div className="text-[11.5px] leading-snug text-slate-500">Based on data profiling and best practices for data modernization.</div>
        </div>
      </div>
      <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-thin">
        {recs.length === 0 && <div className="py-8 text-center text-xs text-slate-500"><CircleCheck className="mx-auto mb-2 size-5 text-emerald-500" />All recommendations for this dataset have been reviewed.</div>}
        {recs.map((r) => (
          <div key={r.id} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-slate-50">
            <Checkbox checked={isChecked(r)} onChange={(v) => setChecked({ ...checked, [r.id]: v })} className="size-[18px]" />
            <StepIcon category={catOf(r)} className="size-6 rounded-md bg-transparent [&_svg]:size-4" />
            <button className="min-w-0 flex-1 truncate text-left text-[12.5px] text-slate-700 hover:text-brand-700" onClick={() => openPreview(r)} title={r.reason}>{r.title}</button>
            <button onClick={() => openPreview(r)} className="hidden text-slate-400 hover:text-brand-600 group-hover:block" aria-label="Preview"><Eye className="size-3.5" /></button>
            <span className={cn("rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold capitalize ring-1", PRIORITY[r.impact])}>{r.impact}</span>
          </div>
        ))}
      </div>
      {recs.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          <Button variant="primary" className="w-full" onClick={() => (sel.some((r) => r.destructive) ? setConfirm(true) : apply(sel.map((r) => r.id)))} disabled={!sel.length} loading={applying}>
            <Sparkles /> Apply selected ({sel.length})
          </Button>
          <Button variant="ghost" size="sm" className="w-full text-brand-700" onClick={() => setExplain(true)} disabled={!sel.length}>Why these suggestions?</Button>
        </div>
      )}
      <Dialog open={explain} onOpenChange={setExplain} title="Why AI recommends these" description="Every recommendation is based on measured facts in your data and validated by the policy engine." size="lg"
        footer={<><Button variant="ghost" onClick={() => setExplain(false)}>Close</Button><Button variant="primary" onClick={() => { setExplain(false); sel.some((r) => r.destructive) ? setConfirm(true) : void apply(sel.map((r) => r.id)); }}>Apply Selected ({sel.length})</Button></>}>
        <div className="space-y-3">
          {sel.map((r) => (
            <div key={r.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">{r.title}</span>
                <span className={cn("rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold capitalize ring-1", PRIORITY[r.impact])}>{r.impact}</span>
                <AIBadge label={`${Math.round(r.confidence * 100)}% confidence`} />
                {r.destructive && <Badge tone="amber">Removes records</Badge>}
              </div>
              <div className="mt-2 text-sm text-slate-600"><b className="text-slate-700">Reason:</b> {r.reason}</div>
              <div className="mt-1 text-sm text-slate-600"><b className="text-slate-700">Benefit:</b> {r.expected_benefit}</div>
              <div className="mt-2 flex gap-2 rounded-lg ai-surface p-2.5 text-[13px] text-slate-700 ring-1 ring-ai-100"><Lightbulb className="mt-0.5 size-4 shrink-0 text-ai-600" />{r.explanation}</div>
            </div>
          ))}
        </div>
      </Dialog>
      <Dialog open={!!previewRec} onOpenChange={(v) => !v && setPreviewRec(null)} title={previewRec?.title ?? ""} description={previewRec?.reason} size="xl"
        footer={<><Button variant="ghost" onClick={() => setPreviewRec(null)}>Close</Button><Button variant="primary" onClick={() => { const r = previewRec!; setPreviewRec(null); void apply([r.id]); }}>Apply</Button></>}>
        {previewRec && <div className="mb-4 flex gap-2 rounded-lg ai-surface p-3 text-sm text-slate-700 ring-1 ring-ai-100"><Lightbulb className="mt-0.5 size-4 shrink-0 text-ai-600" />{previewRec.explanation}</div>}
        {preview ? <BeforeAfter preview={preview} /> : <div className="flex items-center gap-2 py-10 text-sm text-slate-500"><Spinner /> Previewing on your data…</div>}
      </Dialog>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Apply recommendations that remove records?"
        description={<>Some selected recommendations remove records from the cleaned (Silver) data: {sel.filter((r) => r.destructive).map((r) => r.title).join(", ")}. Bronze keeps every original record, and you can undo at any time.</>}
        confirmLabel={`Apply ${sel.length}`} onConfirm={() => { setConfirm(false); void apply(sel.map((r) => r.id)); }} />
    </Panel>
  );
}

// ------------------------------------------------------------------ data preview
export function DataPreviewPanel({ preview, stepPreview, stepLabel, datasetName, loading }: { preview: Preview | null; stepPreview: Preview | null; stepLabel?: string; datasetName: string; loading: boolean }) {
  const [tab, setTab] = useState<"data" | "stats" | "quality" | "schema">("data");
  const [q, setQ] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const p = preview;
  const ch = p?.changes;
  const changedSet = useMemo(() => new Set((ch?.changed_cells_sample ?? []).map((c) => `${c.row_id}:${c.column}`)), [ch]);
  const removed = useMemo(() => new Set(ch?.removed_row_ids ?? []), [ch]);
  const afterRows = (p?.after.rows ?? []).filter((r) => !ch?.aligned || !removed.has(r.__row_id));
  const rows = q ? afterRows.filter((r) => Object.values(r).some((v) => formatCell(v).toLowerCase().includes(q.toLowerCase()))) : afterRows;
  const changedCols = new Set([...(ch ? Object.keys(ch.changed_columns) : []), ...(ch?.added_columns ?? [])]);
  const cols = (p?.after.columns ?? []).filter((c) => !onlyChanged || changedCols.has(c.name) || c === p?.after.columns[0]).map((c) => ({ ...c, highlight: ch?.added_columns.includes(c.name) ? ("added" as const) : ch?.changed_columns[c.name] ? ("changed" as const) : undefined }));
  const numbered = rows.map((r, i) => ({ "#": i + 1, ...r }));

  return (
    <Panel title={stepPreview ? "Before / After Preview" : "Data Preview After Transformations"} info="Live on a sample of your data. Changed cells are highlighted." className="min-h-[520px]"
      actions={loading && <span className="flex items-center gap-1.5 text-xs text-slate-500"><Spinner /> Updating…</span>}>
      {stepPreview ? (
        <>
          <div className="mb-3 text-[13px] text-slate-500">Previewing <b className="text-slate-800">{stepLabel}</b> on {datasetName}. Nothing is saved until you click Save or Add.</div>
          <BeforeAfter preview={stepPreview} maxHeight={320} />
        </>
      ) : (
        <>
          <LineTabs value={tab} onChange={setTab} tabs={[{ value: "data", label: "Data Preview" }, { value: "stats", label: "Column Statistics" }, { value: "quality", label: "Data Quality" }, { value: "schema", label: "Schema" }]} className="mb-3" />
          {!p ? <div className="skeleton h-72" /> : (
            <>
              {tab === "data" && (
                <>
                  <div className="mb-2.5 flex flex-wrap items-center gap-3">
                    <span className="text-[13px] text-slate-600">Dataset: <b className="text-slate-800">{datasetName}</b> <span className="text-slate-400">({fmtNumber(p.after.metrics.rows)} rows)</span></span>
                    <div className="relative w-52"><Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search data…" className="h-8 pl-8 text-xs" /></div>
                    <label className="flex items-center gap-2 text-[12.5px] text-slate-600"><Switch checked={onlyChanged} onCheckedChange={setOnlyChanged} /> Show only changed columns</label>
                    <span className="ml-auto text-xs text-slate-500">Showing 1-{rows.length} of {fmtNumber(p.after.metrics.rows)} rows</span>
                  </div>
                  <DataGrid
                    columns={[{ name: "#" }, ...cols]}
                    rows={numbered}
                    maxHeight={360}
                    cellClass={(r, c) => (c === "#" ? "text-slate-400" : changedSet.has(`${r.__row_id}:${c}`) ? "bg-amber-50 font-medium text-amber-900" : ch?.added_columns.includes(c) ? "bg-emerald-50/70 text-emerald-900" : undefined)}
                  />
                </>
              )}
              {tab === "stats" && (
                <div className="overflow-auto rounded-xl border border-slate-200 scrollbar-thin" style={{ maxHeight: 400 }}>
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Column</th><th className="px-3 py-2">Type</th><th className="px-3 py-2 text-right">Empty</th><th className="px-3 py-2 text-right">Distinct</th><th className="px-3 py-2">Examples</th></tr></thead>
                    <tbody>
                      {p.after.columns.map((c) => {
                        const vals = afterRows.map((r) => r[c.name]);
                        const empty = vals.filter((v) => v === null || v === undefined || v === "").length;
                        const distinct = new Set(vals.map((v) => formatCell(v))).size;
                        return (
                          <tr key={c.name} className="border-t border-slate-100">
                            <td className="px-3 py-1.5 font-mono text-slate-800">{c.name}</td>
                            <td className="px-3 py-1.5 text-slate-500">{c.type.replace("String", "text")}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{vals.length ? `${((empty / vals.length) * 100).toFixed(0)}%` : "—"}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{distinct}</td>
                            <td className="max-w-[260px] truncate px-3 py-1.5 font-mono text-slate-500">{Array.from(new Set(vals.filter((v) => v !== null && v !== "").map(formatCell))).slice(0, 3).join(" · ")}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-400">Calculated from the preview sample.</div>
                </div>
              )}
              {tab === "quality" && (
                <div className="space-y-3">
                  <MetricsCompare before={p.before.metrics} after={p.after.metrics} />
                  {p.after.metrics.quality && p.before.metrics.quality && (
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                      {(["completeness", "validity", "uniqueness", "consistency"] as const).map((k) => (
                        <div key={k} className="rounded-lg border border-slate-200 px-3 py-2">
                          <div className="text-[11px] capitalize text-slate-500">{k}</div>
                          <div className="text-sm"><span className="text-slate-400">{p.before.metrics.quality![k]}%</span> → <b className="text-emerald-600">{p.after.metrics.quality![k]}%</b></div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {tab === "schema" && (
                <div className="overflow-auto rounded-xl border border-slate-200 scrollbar-thin" style={{ maxHeight: 400 }}>
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Column</th><th className="px-3 py-2">Before</th><th className="px-3 py-2">After</th><th className="px-3 py-2">Change</th></tr></thead>
                    <tbody>
                      {p.after.columns.map((c) => {
                        const b = p.before.columns.find((x) => x.name === c.name);
                        const change = !b ? "added" : b.type !== c.type ? "type changed" : ch?.changed_columns[c.name] ? "values standardized" : "";
                        return (
                          <tr key={c.name} className="border-t border-slate-100">
                            <td className="px-3 py-1.5 font-mono">{c.name}</td>
                            <td className="px-3 py-1.5 text-slate-500">{b?.type.replace("String", "text") ?? "—"}</td>
                            <td className="px-3 py-1.5 text-slate-700">{c.type.replace("String", "text")}</td>
                            <td className="px-3 py-1.5">{change && <Badge tone={change === "added" ? "green" : change === "type changed" ? "brand" : "amber"}>{change}</Badge>}</td>
                          </tr>
                        );
                      })}
                      {p.before.columns.filter((c) => !p.after.columns.some((a) => a.name === c.name)).map((c) => (
                        <tr key={c.name} className="border-t border-slate-100 text-slate-400"><td className="px-3 py-1.5 font-mono line-through">{c.name}</td><td className="px-3 py-1.5">{c.type}</td><td className="px-3 py-1.5">—</td><td className="px-3 py-1.5"><Badge tone="red">removed / renamed</Badge></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ summary
export function SummaryPanel({ preview, steps, piiCount, onExportSpec, onExportCsv }: { preview: Preview | null; steps: TransformStep[]; piiCount: number; onExportSpec: () => void; onExportCsv: () => void }) {
  const [menu, setMenu] = useState(false);
  const b = preview?.before.metrics;
  const a = preview?.after.metrics;
  const pct = (v?: number) => (v === undefined ? "—" : `${Number(v.toFixed(1))}%`);
  const impact: { icon: React.ReactNode; label: string; before: string; after: string; good: boolean }[] = [];
  if (a && b) {
    impact.push({ icon: <ShieldCheck className="size-4" />, label: "Data Quality Score", before: pct(b.quality_score), after: pct(a.quality_score), good: a.quality_score >= b.quality_score });
    impact.push({ icon: <CircleCheck className="size-4" />, label: "Missing Values", before: pct(b.null_pct), after: pct(a.null_pct), good: a.null_pct <= b.null_pct });
    const ib = b.invalid_by_type ?? {};
    const ia = a.invalid_by_type ?? {};
    if (ib.email) impact.push({ icon: <CircleCheck className="size-4" />, label: "Invalid Emails", before: pct(ib.email.pct), after: pct(ia.email?.pct ?? 0), good: (ia.email?.pct ?? 0) <= ib.email.pct });
    if (ib.phone) impact.push({ icon: <CircleCheck className="size-4" />, label: "Non-standard Phone Numbers", before: pct(ib.phone.pct), after: pct(ia.phone?.pct ?? 0), good: (ia.phone?.pct ?? 0) <= ib.phone.pct });
    if (b.format_columns && a.format_columns) impact.push({ icon: <CircleCheck className="size-4" />, label: "Standardized Formats", before: `${b.format_columns.consistent}`, after: `${a.format_columns.consistent} columns`, good: a.format_columns.consistent >= b.format_columns.consistent });
  }
  const enabled = steps.filter((s) => s.enabled).length;
  return (
    <Panel title="Transformation Summary" actions={
      <div className="relative">
        <Button size="sm" variant="secondary" onClick={() => setMenu((v) => !v)}><Download /> Export</Button>
        {menu && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
            <div className="absolute right-0 top-9 z-30 w-56 rounded-lg border border-slate-200 bg-white p-1 shadow-lift">
              <button className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-slate-50" onClick={() => { setMenu(false); onExportSpec(); }}>Transformation spec (JSON)</button>
              <button className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-slate-50" onClick={() => { setMenu(false); onExportCsv(); }}>Preview data (CSV)</button>
            </div>
          </>
        )}
      </div>
    }>
      <div className="grid grid-cols-2 gap-2">
        {[
          { v: fmtNumber(a?.rows), l: a && b && a.rows !== b.rows ? `Rows (was ${fmtNumber(b.rows)})` : "Rows (unchanged)" },
          { v: a?.columns ?? "—", l: a && b && a.columns !== b.columns ? `Columns (was ${b.columns})` : "Columns" },
          { v: enabled, l: "Transformations applied" },
          { v: a?.duplicates ?? "—", l: preview?.changes.rows_removed ? `Duplicate rows (removed ${fmtNumber(preview.changes.rows_removed)})` : "Duplicate rows" },
        ].map((t) => (
          <div key={t.l} className="rounded-xl bg-slate-50 px-3.5 py-3">
            <div className="font-display text-xl font-bold tabular-nums text-slate-900">{t.v}</div>
            <div className="text-[11px] leading-tight text-slate-500">{t.l}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 text-[14px] font-semibold text-slate-900">Data Modernization Impact</div>
      <div className="mt-2 space-y-2">
        {!preview && <div className="skeleton h-32" />}
        {impact.map((i) => (
          <div key={i.label} className="flex items-center gap-2.5 text-[13px]">
            <span className="text-brand-600">{i.icon}</span>
            <span className="flex-1 text-slate-700">{i.label}</span>
            <span className="text-slate-400">{i.before}</span>
            <span className="text-slate-300">→</span>
            <span className={cn("w-20 text-right font-semibold", i.good ? "text-emerald-600" : "text-rose-600")}>{i.after}</span>
          </div>
        ))}
        {preview && (
          <div className="flex items-center gap-2.5 text-[13px]">
            <span className="text-brand-600"><ShieldCheck className="size-4" /></span>
            <span className="flex-1 text-slate-700">PII Classification</span>
            <span className="font-semibold text-emerald-600">{piiCount} sensitive columns tagged</span>
          </div>
        )}
      </div>
      {preview && a && b && a.quality_score >= b.quality_score && (
        <div className="mt-4 flex gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-[12.5px] text-emerald-900">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          Your data is standardized, clean and ready for ingestion into Databricks with enterprise-grade quality and governance.
        </div>
      )}
    </Panel>
  );
}

