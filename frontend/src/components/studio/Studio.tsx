"use client";

import { Background, Handle, PanOnScrollMode, Position, ReactFlow, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Binary, Calendar, CircleCheck, CircleDashed, CircleX, Columns3, Copy, Database, Eye, Filter, Globe, GripVertical, ListTree, Lock, Merge, Pencil, Plus, Search, ShieldCheck,
  Sigma, Sparkles, SquareFunction, Table, Trash2, Type, Workflow, Wand, X, ArrowUp, ArrowDown, Copy as CopyIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RecommendationPanel } from "@/components/ai/Recommendations";
import { AIBadge, Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, Input, Segmented, Spinner, Switch, Tabs, TabsList, TabsTrigger, Tooltip } from "@/components/ui";
import { api } from "@/lib/api";
import { showError, useDebounced, useTransformLibrary } from "@/lib/hooks";
import type { ColumnInfo, Pipeline, Preview, TransformSpec, TransformStep } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BeforeAfter } from "./BeforeAfter";
import { ParamForm } from "./ParamForm";

const CAT_ICON: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  clean: Sparkles, types: Binary, text: Type, datetime: Calendar, missing: CircleDashed, duplicates: Copy, filter: Filter, join: Merge, aggregate: Sigma,
  pivot: Table, schema: Columns3, derived: SquareFunction, enrich: Globe, quality: ShieldCheck, pii: Lock,
};
const CAT_COLOR: Record<string, string> = {
  clean: "#6366f1", types: "#0ea5e9", text: "#14b8a6", datetime: "#f59e0b", missing: "#94a3b8", duplicates: "#ef4444", filter: "#8b5cf6", join: "#ec4899",
  aggregate: "#10b981", pivot: "#06b6d4", schema: "#64748b", derived: "#7c3aed", enrich: "#22c55e", quality: "#16a34a", pii: "#e11d48",
};

type Selection = { kind: "step"; id: string } | { kind: "draft"; type: string } | null;

interface StudioProps {
  pipeline: Pipeline;
  mutate: (label: string, fn: () => Promise<any>, opts?: { success?: string; silent?: boolean }) => Promise<any>;
  busy: string | null;
}

function defaults(spec: TransformSpec): Record<string, any> {
  return Object.fromEntries(spec.params.filter((p) => p.default !== null && p.default !== undefined).map((p) => [p.name, p.default]));
}

// ------------------------------------------------------------------ flow nodes
type StepNodeData = { label: string; sub: string; category: string; origin?: string; enabled?: boolean; status?: string; selected?: boolean; kind: "source" | "step" | "output" | "add"; onClick?: () => void };

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const Icon = data.kind === "source" ? Database : data.kind === "output" ? ShieldCheck : data.kind === "add" ? Plus : CAT_ICON[data.category] ?? Wand;
  const color = data.kind === "source" ? "#0c1330" : data.kind === "output" ? "#10b981" : CAT_COLOR[data.category] ?? "#6366f1";
  if (data.kind === "add")
    return (
      <button onClick={data.onClick} className="flex h-10 w-[300px] items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white/70 text-sm font-medium text-slate-500 hover:border-brand-400 hover:text-brand-600">
        <Handle type="target" position={Position.Top} />
        <Plus className="size-4" /> Add transformation
      </button>
    );
  return (
    <div
      onClick={data.onClick}
      className={cn(
        "w-[300px] cursor-pointer rounded-xl border bg-white px-3 py-2.5 shadow-card transition-all hover:shadow-lift",
        data.selected ? "border-brand-500 ring-2 ring-brand-200" : "border-slate-200",
        data.enabled === false && "opacity-50",
        data.status === "error" && "border-rose-300 ring-2 ring-rose-100",
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: color }}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-slate-800">{data.label}</div>
          <div className="truncate text-[11px] text-slate-500">{data.sub}</div>
        </div>
        {data.origin === "ai" && <span className="rounded bg-ai-50 px-1 text-[9px] font-bold text-ai-600 ring-1 ring-ai-200">AI</span>}
        {data.status === "error" && <CircleX className="size-4 text-rose-500" />}
        {data.status === "ok" && data.kind === "step" && <CircleCheck className="size-3.5 text-emerald-500" />}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const nodeTypes = { step: StepNode };

// ------------------------------------------------------------------ library
function Library({ onPick, filter }: { onPick: (t: TransformSpec) => void; filter?: string }) {
  const lib = useTransformLibrary();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ clean: true });
  if (!lib) return <div className="p-4"><Spinner /></div>;
  const term = (filter ?? q).toLowerCase();
  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${lib.transforms.length} transformations`} className="h-8 pl-8 text-xs" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin">
        {lib.categories.map((c) => {
          const items = lib.transforms.filter((t) => t.category === c.id && (!term || (t.label + " " + t.description + " " + t.keywords.join(" ")).toLowerCase().includes(term)));
          if (!items.length) return null;
          const Icon = CAT_ICON[c.id] ?? Wand;
          const isOpen = !!term || open[c.id];
          return (
            <div key={c.id} className="mb-1">
              <button onClick={() => setOpen({ ...open, [c.id]: !open[c.id] })} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-100">
                <Icon className="size-3.5" style={{ color: CAT_COLOR[c.id] } as React.CSSProperties} />
                {c.label}
                <span className="ml-auto text-[10px] font-normal text-slate-400">{items.length}</span>
              </button>
              {isOpen && (
                <div className="ml-2 border-l border-slate-100 pl-2">
                  {items.map((t) => (
                    <Tooltip key={t.id} content={t.description} side="right">
                      <button onClick={() => onPick(t)} className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-slate-600 hover:bg-brand-50 hover:text-brand-700">
                        <span className="truncate">{t.label}</span>
                        <Plus className="ml-auto size-3.5 shrink-0 opacity-0 group-hover:opacity-100" />
                      </button>
                    </Tooltip>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ studio
export function Studio({ pipeline, mutate, busy }: StudioProps) {
  const lib = useTransformLibrary();
  const meta = pipeline.metadata;
  const datasets = meta.source.datasets.filter((d) => d.selected);
  const dsNames = datasets.map((d) => ({ id: d.id, name: d.name.split(" › ").pop() ?? d.name }));
  const [datasetId, setDatasetId] = useState<string>(datasets[0]?.id ?? "");
  const [view, setView] = useState<"flow" | "table">("flow");
  const [sel, setSel] = useState<Selection>(null);
  const [params, setParams] = useState<Record<string, any>>({});
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rightColumns, setRightColumns] = useState<ColumnInfo[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [recsOpen, setRecsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TransformStep | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [stepStatus, setStepStatus] = useState<Record<string, { status: string; message?: string }>>({});
  const previewSeq = useRef(0);
  const flowBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!datasets.some((d) => d.id === datasetId) && datasets[0]) setDatasetId(datasets[0].id);
  }, [datasets, datasetId]);

  const steps = useMemo(() => meta.transformations.filter((t) => t.dataset_id === datasetId), [meta.transformations, datasetId]);
  const step = sel?.kind === "step" ? steps.find((s) => s.id === sel.id) : undefined;
  const specId = sel?.kind === "draft" ? sel.type : step?.type;
  const spec = lib?.transforms.find((t) => t.id === specId);
  const pendingRecs = meta.recommendations.filter((r) => r.status === "pending" && r.dataset_id === datasetId && r.area === "transformation").length;

  // columns available at the selected position
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

  const debouncedParams = useDebounced(params, 450);

  const runPreview = useCallback(async () => {
    if (!datasetId) return;
    const seq = ++previewSeq.current;
    setPreviewing(true);
    try {
      let body: Record<string, unknown> = { dataset_id: datasetId };
      if (sel?.kind === "draft") body = { ...body, draft: { type: sel.type, params: debouncedParams } };
      else if (sel?.kind === "step" && step) {
        const changed = JSON.stringify(step.params) !== JSON.stringify(debouncedParams);
        body = changed ? { ...body, draft: { type: step.type, params: debouncedParams }, replace_step_id: step.id } : { ...body, step_id: step.id };
      }
      const res = await api.post<Preview>(`/api/pipelines/${pipeline.id}/preview`, body);
      if (seq !== previewSeq.current) return;
      setPreview(res);
      if (!sel) setStepStatus(Object.fromEntries(res.step_results.map((r) => [r.step_id, { status: r.status, message: r.message }])));
    } catch (e) {
      if (seq === previewSeq.current) setPreview(null);
      showError(e, "Preview failed");
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.id, datasetId, sel, debouncedParams, step?.id, meta.transformations]);

  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  const pickTransform = (t: TransformSpec) => {
    const p = defaults(t);
    // Pre-select the most plausible column so most steps work with a single click.
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
    if (res?.step_id) {
      setSel({ kind: "step", id: res.step_id });
    }
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
  const move = (i: number, d: number) => {
    const ids = steps.map((s) => s.id);
    const [x] = ids.splice(i, 1);
    ids.splice(i + d, 0, x);
    void reorder(ids);
  };

  const specOf = (type: string) => lib?.transforms.find((t) => t.id === type);

  const nodes: Node<StepNodeData>[] = useMemo(() => {
    const ds = dsNames.find((d) => d.id === datasetId);
    const out: Node<StepNodeData>[] = [
      { id: "source", type: "step", position: { x: 0, y: 0 }, data: { kind: "source", label: ds?.name ?? "Source", sub: "Raw data (Bronze)", category: "source", onClick: () => setSel(null), selected: !sel } },
    ];
    steps.forEach((s, i) => {
      const sp = specOf(s.type);
      const cat = sp?.category ?? "clean";
      out.push({
        id: s.id, type: "step", position: { x: 0, y: (i + 1) * 78 },
        data: { kind: "step", label: s.label || sp?.label || s.type, sub: `${lib?.categories.find((c) => c.id === cat)?.label ?? ""}${s.origin === "template" ? " · template" : ""}`, category: cat, origin: s.origin, enabled: s.enabled, status: stepStatus[s.id]?.status, selected: sel?.kind === "step" && sel.id === s.id, onClick: () => selectStep(s) },
      });
    });
    out.push({ id: "add", type: "step", position: { x: 0, y: (steps.length + 1) * 78 }, data: { kind: "add", label: "", sub: "", category: "", onClick: () => setView("flow") } });
    const silver = meta.lakehouse.tables.find((t) => t.layer === "silver" && t.source_datasets.includes(datasetId));
    out.push({ id: "output", type: "step", position: { x: 0, y: (steps.length + 2) * 78 }, data: { kind: "output", label: silver ? `Silver: ${silver.name}` : "Output", sub: "Clean, validated table", category: "output", onClick: () => setSel(null) } });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, sel, stepStatus, lib, datasetId, meta.lakehouse.tables]);
  const edges = useMemo(() => nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id, animated: n.id === "output", style: { stroke: "#c7d2fe", strokeWidth: 2 } })), [nodes]);

  if (!datasets.length) return <Card><EmptyState icon={<Wand />} title="No datasets yet" description="Connect a source and select datasets first." /></Card>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={datasetId} onValueChange={(v) => { setDatasetId(v); setSel(null); }}>
          <TabsList className="border-none">
            {dsNames.map((d) => (
              <TabsTrigger key={d.id} value={d.id} className="rounded-lg border-b-0 data-[state=active]:bg-white data-[state=active]:shadow-card">
                {d.name}
                <span className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-500">{meta.transformations.filter((t) => t.dataset_id === d.id).length}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-2">
          {pendingRecs > 0 && (
            <Button variant="aiSoft" size="sm" onClick={() => setRecsOpen(true)}>
              <Sparkles /> {pendingRecs} transformation{pendingRecs !== 1 ? "s" : ""} recommended
            </Button>
          )}
          <Segmented size="sm" value={view} onChange={setView} options={[{ value: "flow", label: "Visual Flow", icon: <Workflow /> }, { value: "table", label: "Table View", icon: <ListTree /> }]} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)_400px]">
        <Card className="h-[560px] overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Transformation library</div>
          <div className="h-[calc(100%-45px)]"><Library onPick={pickTransform} /></div>
        </Card>

        <Card className="relative h-[560px] overflow-hidden">
          {view === "flow" ? (
            <div ref={flowBox} className="grid-bg h-full">
              <ReactFlow
                key={datasetId}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onInit={(inst) => {
                  const w = flowBox.current?.clientWidth ?? 600;
                  inst.setViewport({ x: (w - 300 * 0.95) / 2, y: 20, zoom: 0.95 });
                }}
                panOnScroll
                panOnScrollMode={PanOnScrollMode.Vertical}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
                minZoom={0.3}
              >
                <Background gap={18} color="#e2e8f0" />
              </ReactFlow>
            </div>
          ) : (
            <div className="h-full overflow-y-auto scrollbar-thin">
              {steps.length === 0 && <EmptyState icon={<Wand />} title="No transformation steps yet" description="Pick one from the library or apply AI recommendations." />}
              <div className="divide-y divide-slate-100">
                {steps.map((s, i) => {
                  const sp = specOf(s.type);
                  const st = stepStatus[s.id];
                  return (
                    <div
                      key={s.id}
                      draggable
                      onDragStart={() => setDragId(s.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (!dragId || dragId === s.id) return;
                        const ids = steps.map((x) => x.id).filter((x) => x !== dragId);
                        ids.splice(i, 0, dragId);
                        setDragId(null);
                        void reorder(ids);
                      }}
                      onClick={() => selectStep(s)}
                      className={cn("group flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-slate-50", sel?.kind === "step" && sel.id === s.id && "bg-brand-50/60", !s.enabled && "opacity-50")}
                    >
                      <GripVertical className="size-4 cursor-grab text-slate-300" />
                      <span className="w-5 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
                      <div className="flex size-7 items-center justify-center rounded-md text-white" style={{ background: CAT_COLOR[sp?.category ?? "clean"] }}>
                        {(() => { const I = CAT_ICON[sp?.category ?? "clean"] ?? Wand; return <I className="size-3.5" />; })()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-800">{s.label || sp?.label}</div>
                        <div className="truncate text-xs text-slate-500">{sp?.label} {st?.status === "error" && <span className="text-rose-600">· {st.message}</span>}</div>
                      </div>
                      {s.origin === "ai" && <AIBadge />}
                      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <Switch checked={s.enabled} onCheckedChange={() => toggleStep(s)} />
                        <Button variant="ghost" size="icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp /></Button>
                        <Button variant="ghost" size="icon" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down"><ArrowDown /></Button>
                        <Button variant="ghost" size="icon" onClick={() => duplicate(s)} aria-label="Duplicate"><CopyIcon /></Button>
                        <Button variant="ghost" size="icon" onClick={() => setConfirmDelete(s)} aria-label="Delete"><Trash2 /></Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(busy === "reorder" || busy === "toggle" || busy === "delete" || busy === "dup") && <div className="absolute right-3 top-3"><Spinner /></div>}
        </Card>

        <Card className="flex h-[560px] flex-col overflow-hidden">
          {spec && lib ? (
            <>
              <div className="flex items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge tone={sel?.kind === "draft" ? "brand" : "slate"}>{sel?.kind === "draft" ? "New step" : "Editing"}</Badge>
                    {step?.origin === "ai" && <AIBadge label="AI recommended" />}
                  </div>
                  <div className="mt-1 font-semibold text-slate-900">{spec.label}</div>
                  <div className="text-xs text-slate-500">{spec.description}</div>
                </div>
                <button onClick={() => setSel(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="size-4" /></button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
                <ParamForm spec={spec} params={params} setParams={setParams} columns={columns} rightColumns={rightColumns} datasets={dsNames} lib={lib} currentDataset={datasetId} advanced={meta.mode === "advanced"} />
              </div>
              <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3">
                {sel?.kind === "draft" ? (
                  <>
                    <Button variant="ghost" onClick={() => setSel(null)}>Cancel</Button>
                    <Button variant="primary" className="ml-auto" onClick={addStep} loading={busy === "add-step"}><Plus /> Add to pipeline</Button>
                  </>
                ) : step ? (
                  <>
                    <Button variant="dangerSoft" size="sm" onClick={() => setConfirmDelete(step)}><Trash2 /> Delete</Button>
                    <Button variant="ghost" size="sm" onClick={() => duplicate(step)}><CopyIcon /> Duplicate</Button>
                    <Button variant="primary" className="ml-auto" onClick={saveStep} loading={busy === "save-step"} disabled={JSON.stringify(step.params) === JSON.stringify(params)}>
                      <Pencil /> Save changes
                    </Button>
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-50 to-ai-50 text-brand-600 ring-1 ring-brand-100"><Eye className="size-5" /></div>
              <div className="mt-3 font-semibold text-slate-900">Whole-pipeline preview</div>
              <p className="mt-1 text-sm text-slate-500">Below you see the original data next to the result of all {steps.filter((s) => s.enabled).length} active steps. Select a step to preview it alone, or pick a transformation from the library.</p>
              {pendingRecs > 0 && <Button className="mt-4" variant="ai" onClick={() => setRecsOpen(true)}><Sparkles /> Review {pendingRecs} AI recommendation{pendingRecs !== 1 ? "s" : ""}</Button>}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="font-semibold text-slate-900">Before / After preview</div>
            <div className="text-xs text-slate-500">
              {sel?.kind === "draft" ? `Previewing new step: ${spec?.label}` : step ? `Previewing step: ${step.label || spec?.label}` : "Original data vs. all transformations"} · live on a sample of your data
            </div>
          </div>
          {previewing && <div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Updating preview…</div>}
        </div>
        {preview ? <div className={cn(previewing && "opacity-60 transition-opacity")}><BeforeAfter preview={preview} /></div> : <div className="skeleton h-64" />}
      </Card>

      <Dialog open={recsOpen} onOpenChange={setRecsOpen} title="AI transformation recommendations" description={`For ${dsNames.find((d) => d.id === datasetId)?.name}`} size="lg">
        <RecommendationPanel pipeline={pipeline} mutate={mutate} datasetFilter={datasetId} />
      </Dialog>
      <ConfirmDialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)} title="Delete this step?" description={<>“{confirmDelete?.label}” will be removed from the pipeline. You can undo this.</>} confirmLabel="Delete step" destructive onConfirm={() => confirmDelete && remove(confirmDelete)} />
    </div>
  );
}
