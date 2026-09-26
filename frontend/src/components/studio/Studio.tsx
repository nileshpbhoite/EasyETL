"use client";

import { ArrowDownUp, ArrowRight, CircleCheck, CircleX, Plus, Redo2, Settings2, Sparkles, Trash2, Undo2, Workflow, ListTree } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantChat } from "@/components/shell/AssistantPanel";
import { QualityPanel } from "@/components/quality/QualityPanel";
import { FileTypeIcon } from "@/components/source/FileTypeIcon";
import { DataGrid } from "@/components/data/DataGrid";
import { Button, ConfirmDialog, EmptyState, Select, Segmented, Skeleton, Tooltip } from "@/components/ui";
import { PillTabs } from "@/components/wizard/common";
import { api } from "@/lib/api";
import { showError, useApi, useDebounced, useTransformLibrary } from "@/lib/hooks";
import { useUI } from "@/lib/store";
import type { ColumnInfo, Pipeline, Preview, TransformSpec, TransformStep } from "@/lib/types";
import { cn, fmtCompact, fmtNumber } from "@/lib/utils";
import { STAGES } from "./catalog";
import { AppliedList, DataPreviewPanel, Library, Panel, RecsPanel, SettingsPanel, SummaryPanel } from "./panels";

type Selection = { kind: "step"; id: string } | { kind: "draft"; type: string } | null;
type Tab = "preview" | "transform" | "quality" | "enrich" | "schema" | "assistant";

interface StudioProps {
  pipeline: Pipeline;
  mutate: (label: string, fn: () => Promise<any>, opts?: { success?: string; silent?: boolean }) => Promise<any>;
  busy: string | null;
}

function defaults(spec: TransformSpec): Record<string, any> {
  return Object.fromEntries(spec.params.filter((p) => p.default !== null && p.default !== undefined).map((p) => [p.name, p.default]));
}

function download(name: string, content: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

function RawPreview({ pipelineId, datasetId }: { pipelineId: string; datasetId: string }) {
  const [stage, setStage] = useState<"raw" | "transformed">("transformed");
  const { data, loading } = useApi<{ columns: { name: string; type: string }[]; rows: Record<string, any>[]; total_rows: number }>(`/api/pipelines/${pipelineId}/datasets/${datasetId}/preview?stage=${stage}&limit=200`, [stage, datasetId]);
  return (
    <Panel title="Data Preview" info="Browse your data as received (Bronze) or after all transformations (Silver)." actions={<Segmented size="sm" value={stage} onChange={setStage} options={[{ value: "raw", label: "Original" }, { value: "transformed", label: "Transformed" }]} />}>
      {loading || !data ? <Skeleton className="h-96" /> : (
        <>
          <div className="mb-2 text-xs text-slate-500">Showing 1-{data.rows.length} of {fmtNumber(data.total_rows)} rows · {data.columns.length} columns</div>
          <DataGrid columns={data.columns} rows={data.rows} maxHeight={560} />
        </>
      )}
    </Panel>
  );
}

export function Studio({ pipeline, mutate, busy }: StudioProps) {
  const lib = useTransformLibrary();
  const meta = pipeline.metadata;
  const { setAssistantContext } = useUI();
  const datasets = meta.source.datasets.filter((d) => d.selected);
  const dsNames = datasets.map((d) => ({ id: d.id, name: d.name.split(" › ").pop() ?? d.name }));
  const [datasetId, setDatasetId] = useState<string>(datasets[0]?.id ?? "");
  const [tab, setTab] = useState<Tab>("transform");
  const [view, setView] = useState<"flow" | "table">("flow");
  const [stage, setStage] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [params, setParams] = useState<Record<string, any>>({});
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rightColumns, setRightColumns] = useState<ColumnInfo[]>([]);
  const [pipePreview, setPipePreview] = useState<Preview | null>(null);
  const [stepPreview, setStepPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TransformStep | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!datasets.some((d) => d.id === datasetId) && datasets[0]) setDatasetId(datasets[0].id);
  }, [datasets, datasetId]);
  useEffect(() => {
    setAssistantContext({ pipelineId: pipeline.id, page: "transform", datasetId });
  }, [pipeline.id, datasetId, setAssistantContext]);

  const allSteps = useMemo(() => meta.transformations.filter((t) => t.dataset_id === datasetId), [meta.transformations, datasetId]);
  const specOf = useCallback((type: string) => lib?.transforms.find((t) => t.id === type), [lib]);
  const stageOf = useCallback((type: string) => STAGES.find((s) => s.cats.includes(specOf(type)?.category ?? ""))?.id ?? "clean", [specOf]);
  const steps = stage ? allSteps.filter((s) => stageOf(s.type) === stage) : allSteps;
  const step = sel?.kind === "step" ? allSteps.find((s) => s.id === sel.id) : undefined;
  const spec = specOf(sel?.kind === "draft" ? sel.type : step?.type ?? "");
  const status = Object.fromEntries((pipePreview?.step_results ?? []).map((r) => [r.step_id, { status: r.status, message: r.message }]));
  const ds = datasets.find((d) => d.id === datasetId);
  const dsName = dsNames.find((d) => d.id === datasetId)?.name ?? "";
  const profile = meta.analysis.profiles[datasetId];
  const silver = meta.lakehouse.tables.find((t) => t.layer === "silver" && t.source_datasets.includes(datasetId));

  useEffect(() => {
    if (!datasetId) return;
    const q = sel?.kind === "step" ? `?before_step=${sel.id}` : "";
    api.get<ColumnInfo[]>(`/api/pipelines/${pipeline.id}/datasets/${datasetId}/columns${q}`).then(setColumns).catch(() => setColumns([]));
  }, [pipeline.id, datasetId, sel, meta.transformations.length]);
  useEffect(() => {
    const rd = params.right_dataset as string | undefined;
    if (!rd) return setRightColumns([]);
    api.get<ColumnInfo[]>(`/api/pipelines/${pipeline.id}/datasets/${rd}/columns`).then(setRightColumns).catch(() => setRightColumns([]));
  }, [pipeline.id, params.right_dataset]);

  // Whole-pipeline preview drives the summary, step statuses and the data preview.
  const stepsKey = JSON.stringify(allSteps.map((s) => [s.id, s.enabled, s.params]));
  useEffect(() => {
    if (!datasetId) return;
    let alive = true;
    setLoadingPreview(true);
    api.post<Preview>(`/api/pipelines/${pipeline.id}/preview`, { dataset_id: datasetId, rows: 60 })
      .then((p) => { if (alive) setPipePreview(p); })
      .catch((e) => { if (alive) showError(e, "Preview failed"); })
      .finally(() => { if (alive) setLoadingPreview(false); });
    return () => { alive = false; };
  }, [pipeline.id, datasetId, stepsKey]);

  // Preview of the selected step or unsaved draft.
  const dParams = useDebounced(params, 450);
  useEffect(() => {
    if (!sel || !datasetId) {
      setStepPreview(null);
      return;
    }
    const n = ++seq.current;
    let body: Record<string, unknown> = { dataset_id: datasetId };
    if (sel.kind === "draft") body = { ...body, draft: { type: sel.type, params: dParams } };
    else if (step) body = JSON.stringify(step.params) !== JSON.stringify(dParams) ? { ...body, draft: { type: step.type, params: dParams }, replace_step_id: step.id } : { ...body, step_id: step.id };
    setLoadingPreview(true);
    api.post<Preview>(`/api/pipelines/${pipeline.id}/preview`, body)
      .then((p) => { if (n === seq.current) setStepPreview(p); })
      .catch(() => { if (n === seq.current) setStepPreview(null); })
      .finally(() => { if (n === seq.current) setLoadingPreview(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, dParams, datasetId, step?.id]);

  const pickTransform = (t: TransformSpec) => {
    const p = defaults(t);
    for (const ps of t.params.filter((x) => x.type === "column" && x.required && !x.name.startsWith("right"))) {
      const hint = (ps.label + " " + t.label).toLowerCase();
      const bySemantic = columns.find((c) => c.semantic_type && hint.includes(c.semantic_type.replace(/_/g, " ").split(" ")[0]));
      const byKind = ps.column_kind !== "any" ? columns.find((c) => c.kind === ps.column_kind) : undefined;
      const pick = (hint.includes("birth") && columns.find((c) => c.semantic_type === "date_of_birth" || c.name.toLowerCase().includes("birth"))) || bySemantic || byKind;
      if (pick) p[ps.name] = pick.name;
    }
    setSel({ kind: "draft", type: t.id });
    setParams(p);
  };
  const selectStep = (s: TransformStep) => {
    setSel({ kind: "step", id: s.id });
    setParams(s.params ?? {});
  };
  const addStep = async () => {
    if (sel?.kind !== "draft") return;
    const res = await mutate("add-step", () => api.post<Pipeline & { step_id: string }>(`/api/pipelines/${pipeline.id}/transformations`, { dataset_id: datasetId, type: sel.type, params }), { success: `Added: ${spec?.label}` });
    if (res?.step_id) setSel({ kind: "step", id: res.step_id });
  };
  const saveStep = () => step && mutate("save-step", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}/transformations/${step.id}`, { params }), { success: "Step updated" });
  const toggleStep = (s: TransformStep) => mutate("toggle", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}/transformations/${s.id}`, { enabled: !s.enabled }));
  const duplicate = (s: TransformStep) => mutate("dup", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/transformations/${s.id}/duplicate`), { success: "Step duplicated" });
  const remove = async (s: TransformStep) => {
    setConfirmDelete(null);
    if (sel?.kind === "step" && sel.id === s.id) setSel(null);
    await mutate("delete", () => api.del<Pipeline>(`/api/pipelines/${pipeline.id}/transformations/${s.id}`), { success: "Step removed" });
  };
  const reorder = (order: string[]) => {
    const others = meta.transformations.filter((t) => t.dataset_id !== datasetId).map((t) => t.id);
    return mutate("reorder", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/transformations/reorder`, { order: [...others, ...order] }));
  };
  const idsInOrder = allSteps.map((s) => s.id);
  const move = (i: number, d: number) => {
    const target = steps[i + d]?.id;
    if (!target) return;
    const ids = [...idsInOrder];
    const a = ids.indexOf(steps[i].id);
    const b = ids.indexOf(target);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    void reorder(ids);
  };
  const dropAt = (dragId: string, index: number) => {
    const ids = idsInOrder.filter((x) => x !== dragId);
    const targetId = steps[index]?.id;
    ids.splice(targetId ? ids.indexOf(targetId) : ids.length, 0, dragId);
    void reorder(ids);
  };
  const lastUndo = meta.history[meta.history.length - 1]?.event === "undo";
  const pendingIds = meta.recommendations.filter((r) => r.status === "pending" && r.area === "transformation" && r.dataset_id === datasetId).map((r) => r.id);

  if (!datasets.length) return <EmptyState icon={<Workflow />} title="No datasets yet" description="Connect a source and select datasets first." />;
  if (!lib) return <Skeleton className="h-[640px]" />;

  const applyAllRecs = () => mutate("apply", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/recommendations/apply`, { ids: pendingIds }), { success: `Applied ${pendingIds.length} AI suggestions` });
  const applyAll = pendingIds.length > 0 && (
    <Button variant="primary" onClick={applyAllRecs} loading={busy === "apply"}><Sparkles /> Apply {pendingIds.length} AI suggestion{pendingIds.length !== 1 ? "s" : ""}</Button>
  );
  const stageSteps = (id: string) => allSteps.filter((x) => x.enabled && stageOf(x.type) === id);
  const stageError = (id: string) => stageSteps(id).some((s) => status[s.id]?.status === "error");
  const visibleStages = STAGES.filter((s) => s.id !== "protect" || stageSteps("protect").length);
  const libCat = tab === "enrich" ? "enrich" : tab === "schema" ? "schema" : null;
  const inStudio = tab === "transform" || tab === "enrich" || tab === "schema";

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-card">
        <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-4">
          <FileTypeIcon format={meta.source.category === "file" ? ds?.format : meta.source.category === "api" ? "api" : "table"} size={32} />
          <div className="min-w-0">
            {datasets.length > 1 ? (
              <Select value={datasetId} onChange={(v) => { setDatasetId(v); setSel(null); setStage(null); }} options={dsNames.map((d) => ({ value: d.id, label: d.name }))} className="w-56 [&_select]:h-8 [&_select]:font-semibold" />
            ) : (
              <div className="font-display text-[17px] font-bold text-slate-900">{dsName}</div>
            )}
            <div className="text-xs text-slate-500">{datasets.length > 1 && `${datasets.length} datasets • `}{fmtCompact(ds?.row_count)} rows • {profile?.column_count ?? ds?.column_count} columns</div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Tooltip content="Undo"><Button variant="secondary" size="icon" aria-label="Undo" onClick={() => mutate("undo", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/undo`), { success: "Undone" })} disabled={pipeline.version <= 1}><Undo2 /></Button></Tooltip>
            <Tooltip content="Redo"><Button variant="secondary" size="icon" aria-label="Redo" onClick={() => mutate("redo", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/undo`), { success: "Redone" })} disabled={!lastUndo}><Redo2 /></Button></Tooltip>
            <Tooltip content={meta.mode === "advanced" ? "Advanced options are on (click to hide)" : "Show advanced options"}>
              <Button variant={meta.mode === "advanced" ? "primary" : "secondary"} size="icon" aria-label="Toggle advanced options" onClick={() => mutate("mode", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}`, { mode: meta.mode === "advanced" ? "simple" : "advanced" }))}><Settings2 /></Button>
            </Tooltip>
            {applyAll}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-5 py-2.5">
          <PillTabs value={tab} onChange={(t) => { setTab(t); if (t !== "transform" && t !== "enrich" && t !== "schema") setSel(null); }}
            tabs={[{ value: "transform", label: "Transform" }, { value: "preview", label: "Data Preview" }, { value: "quality", label: "Data Quality" }, { value: "enrich", label: "Enrich & Derive" }, { value: "schema", label: "Schema Mapping" }, { value: "assistant", label: "AI Assistant" }]} />
          {inStudio && <Segmented size="sm" className="ml-auto" value={view} onChange={setView} options={[{ value: "flow", label: "Visual Flow", icon: <Workflow /> }, { value: "table", label: "Table View", icon: <ListTree /> }]} />}
        </div>
        {inStudio && view === "flow" && (
              <div className="flex items-stretch gap-1.5 overflow-x-auto border-t border-slate-100 px-5 pb-4 pt-4 scrollbar-thin">
                <button onClick={() => setStage(null)} className={cn("relative flex min-w-[170px] items-center gap-2.5 rounded-xl border bg-white px-3 py-2.5 text-left", stage === null ? "border-brand-400 bg-brand-50/40" : "border-slate-200 hover:border-slate-300")}>
                  <FileTypeIcon format={meta.source.category === "file" ? ds?.format : "table"} size={24} />
                  <span className="min-w-0"><span className="block text-[13px] font-semibold text-slate-900">Source</span><span className="block truncate text-[11px] text-slate-500">{dsName}</span><span className="block text-[11px] text-slate-400">{fmtCompact(ds?.row_count)} rows • {profile?.column_count ?? "?"} cols</span></span>
                  <CircleCheck className="absolute -right-1.5 -top-1.5 size-4 rounded-full bg-white text-emerald-500" />
                </button>
                {visibleStages.map((s) => {
                  const n = stageSteps(s.id).length;
                  const err = stageError(s.id);
                  const active = stage === s.id;
                  const sub = s.id === "shape" ? `${pipePreview?.after.columns.length ?? "—"} columns` : `${n} ${s.unit}${n !== 1 ? "s" : ""}`;
                  return (
                    <div key={s.id} className="flex items-center gap-1.5">
                      <ArrowRight className="size-4 shrink-0 text-slate-300" />
                      <button onClick={() => setStage(active ? null : s.id)} className={cn("relative flex min-w-[158px] items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all", active ? "border-brand-500 bg-brand-50/60 shadow-[0_4px_14px_-8px_rgb(38_89_235)]" : "border-slate-200 bg-white hover:border-slate-300", n === 0 && !active && "opacity-60")}>
                        <span className={cn("flex size-8 items-center justify-center rounded-lg", active ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-600")}><s.icon className="size-4" /></span>
                        <span className="min-w-0"><span className={cn("block whitespace-nowrap text-[13px] font-semibold", active ? "text-brand-700" : "text-slate-900")}>{s.label}</span><span className="block whitespace-nowrap text-[11px] text-slate-500">{sub}</span></span>
                        {n > 0 && (err ? <CircleX className="absolute -right-1.5 -top-1.5 size-4 rounded-full bg-white text-rose-500" /> : <CircleCheck className="absolute -right-1.5 -top-1.5 size-4 rounded-full bg-white text-emerald-500" />)}
                      </button>
                    </div>
                  );
                })}
                <div className="flex items-center gap-1.5">
                  <ArrowRight className="size-4 shrink-0 text-slate-300" />
                  <div className="relative flex min-w-[150px] items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-rose-50 text-dbx-500"><svg viewBox="0 0 24 24" className="size-5" fill="currentColor"><path d="M12 2 2 7.5l10 5.5 10-5.5L12 2Zm0 13.2L4.3 11 2 12.3l10 5.5 10-5.5L19.7 11 12 15.2Zm0 4.6-7.7-4.2L2 16.9l10 5.5 10-5.5-2.3-1.3-7.7 4.2Z" /></svg></span>
                    <span className="min-w-0"><span className="block text-[13px] font-semibold text-slate-900">Output</span><span className="block max-w-[140px] truncate text-[11px] text-slate-500">{silver ? silver.name : "To Databricks"}</span></span>
                    <CircleCheck className="absolute -right-1.5 -top-1.5 size-4 rounded-full bg-white text-emerald-500" />
                  </div>
                </div>
              </div>
            )}
      </div>

      {tab === "preview" && <RawPreview pipelineId={pipeline.id} datasetId={datasetId} />}
      {tab === "quality" && <QualityPanel pipeline={pipeline} mutate={mutate} />}
      {tab === "assistant" && (
        <Panel title="AI Assistant" info="Grounded in this dataset's profile and your transformation steps." bodyClassName="px-0 pb-0">
          <div className="h-[600px] border-t border-slate-100"><AssistantChat /></div>
        </Panel>
      )}

      {inStudio && (
        <>
          <div className="grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
            <Panel title="Transformation Library" className="h-[640px]" bodyClassName="flex flex-col">
              <Library key={libCat ?? "all"} ref={searchRef} lib={lib} onPick={pickTransform} initialCat={libCat} />
            </Panel>

            <Panel
              title={<>Your Steps ({allSteps.length}){stage && <span className="ml-2 text-[13px] font-normal text-brand-600">· {STAGES.find((s) => s.id === stage)?.label} <button className="underline" onClick={() => setStage(null)}>show all</button></span>}</>}
              info="Steps run top to bottom. Drag to reorder, toggle to disable, or click to edit."
              className="h-[640px]"
              bodyClassName="flex min-h-0 gap-4"
              actions={
                <>
                  <Button size="sm" variant="secondary" className="border-brand-200 text-brand-700" onClick={() => searchRef.current?.focus()}><Plus /> Add</Button>
                  <Button size="sm" variant={reorderMode ? "primary" : "secondary"} onClick={() => setReorderMode((v) => !v)}><ArrowDownUp /> Reorder</Button>
                  <Tooltip content="Remove all steps"><Button size="sm" variant="secondary" className="text-rose-600" aria-label="Clear all" onClick={() => setConfirmClear(true)} disabled={!allSteps.length}><Trash2 /></Button></Tooltip>
                </>
              }
            >
              <div className={cn("min-h-0 overflow-y-auto pr-1 scrollbar-thin", spec ? "hidden flex-1 2xl:block" : "flex-1")}>
                <AppliedList steps={steps} lib={lib} selectedId={sel?.kind === "step" ? sel.id : undefined} status={status} reorderMode={reorderMode} view={view}
                  onSelect={selectStep} onToggle={toggleStep} onDelete={setConfirmDelete} onMove={move} onDrop={dropAt} onDuplicate={duplicate} busy={!!busy}
                  emptyAction={<>{applyAll}<Button variant="secondary" onClick={() => searchRef.current?.focus()}><Plus /> Browse library</Button></>} />
              </div>
              {spec && (
                <div className="flex w-full min-w-0 flex-col border-slate-100 2xl:w-[300px] 2xl:shrink-0 2xl:border-l 2xl:pl-4">
                  <SettingsPanel spec={spec} params={params} setParams={setParams} columns={columns} rightColumns={rightColumns} datasets={dsNames} lib={lib} datasetId={datasetId}
                    advanced={meta.mode === "advanced"} mode={sel?.kind === "draft" ? "draft" : "step"} onCancel={() => setSel(null)} onSave={saveStep} onAdd={addStep}
                    saving={busy === "add-step" || busy === "save-step"} dirty={!!step && JSON.stringify(step.params) !== JSON.stringify(params)} />
                </div>
              )}
            </Panel>

            <RecsPanel pipeline={pipeline} datasetId={datasetId} lib={lib} mutate={mutate} refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await mutate("analyze", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/analyze`), { success: "Recommendations refreshed" }); setRefreshing(false); }} />
          </div>

          <div id="studio-preview" className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <DataPreviewPanel preview={pipePreview} stepPreview={sel ? stepPreview : null} stepLabel={sel?.kind === "step" ? step?.label ?? spec?.label : spec?.label} datasetName={dsName} loading={loadingPreview} />
            <SummaryPanel preview={pipePreview} steps={allSteps} piiCount={meta.governance.pii.filter((p) => p.dataset_id === datasetId).length}
              onExportSpec={() => download(`${dsName}_transformations.json`, JSON.stringify(allSteps.filter((s) => s.enabled).map((s) => ({ type: s.type, params: s.params, label: s.label })), null, 2), "application/json")}
              onExportCsv={() => {
                const rows = pipePreview?.after.rows ?? [];
                const cols = (pipePreview?.after.columns ?? []).map((c) => c.name);
                const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
                download(`${dsName}_preview.csv`, [cols.map(esc).join(","), ...rows.map((r) => cols.map((c) => esc(typeof r[c] === "object" && r[c] !== null ? JSON.stringify(r[c]) : r[c])).join(","))].join("\n"), "text/csv");
              }} />
          </div>
        </>
      )}

      <ConfirmDialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)} title="Delete this step?" description={<>“{confirmDelete?.label}” will be removed from the pipeline. You can undo this.</>} confirmLabel="Delete step" destructive onConfirm={() => confirmDelete && remove(confirmDelete)} />
      <ConfirmDialog open={confirmClear} onOpenChange={setConfirmClear} title="Clear all transformations?" description={<>All {allSteps.length} steps for <b>{dsName}</b> will be removed and their AI recommendations become available again. You can undo this.</>}
        confirmLabel="Clear all" destructive onConfirm={async () => { setConfirmClear(false); setSel(null); await mutate("clear", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/transformations/clear`, { dataset_id: datasetId }), { success: "Transformations cleared" }); }} />
      {busy === "reorder" && <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-lift"><Sparkles className="size-4 animate-pulse text-brand-600" /> Reordering…</div>}
    </div>
  );
}
