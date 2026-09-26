"use client";

import { CircleCheck, CircleX, Plus, ShieldCheck, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip } from "recharts";
import { AIBadge, Badge, Button, Card, CardHeader, Dialog, Field, Input, ScoreRing, Select, Skeleton, Switch, Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ColumnInfo, Pipeline } from "@/lib/types";
import { cn, fmtNumber, humanize } from "@/lib/utils";

interface RuleResult { rule_id: string; status: string; dimension: string; description: string; column?: string; failed?: number; pass_rate?: number; on_fail?: string; examples?: string[]; message?: string }
interface Evaluation { rules: RuleResult[]; dimensions: Record<string, number>; score: number | null; failing_records: number; records: number }
interface QualityData {
  datasets: { dataset_id: string; dataset: string; profile_quality: Record<string, number> | null; before: Evaluation; after: Evaluation; anomalies: { column: string; outliers: number; bounds?: [number, number] }[] }[];
  catalog: { rule: string; label: string; dimension: string; params: string[] }[];
}

const DIMS = ["completeness", "validity", "uniqueness", "consistency", "referential_integrity", "accuracy", "range"];

function CreateRule({ open, onOpenChange, pipeline, datasetId, catalog, onCreate }: { open: boolean; onOpenChange: (v: boolean) => void; pipeline: Pipeline; datasetId: string; catalog: QualityData["catalog"]; onCreate: (r: Record<string, unknown>) => Promise<void> }) {
  const { data: columns } = useApi<ColumnInfo[]>(open ? `/api/pipelines/${pipeline.id}/datasets/${datasetId}/columns` : null, [open]);
  const [rule, setRule] = useState("not_null");
  const [column, setColumn] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [onFail, setOnFail] = useState("warn");
  const [saving, setSaving] = useState(false);
  const spec = catalog.find((c) => c.rule === rule);
  const others = pipeline.metadata.source.datasets.filter((d) => d.selected && d.id !== datasetId);
  const submit = async () => {
    setSaving(true);
    const p: Record<string, unknown> = { ...params };
    if (rule === "in_set") p.values = String(params.values ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (rule === "in_reference") p.reference = "iso_countries";
    await onCreate({ dataset_id: datasetId, column, rule, params: p, on_fail: onFail });
    setSaving(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Create a data quality rule" description="No code — pick a column and a rule." size="md"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={saving} disabled={!column}>Create Rule</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Column" required><Select value={column} onChange={setColumn} placeholder="Choose column" options={(columns ?? []).map((c) => ({ value: c.name, label: c.name }))} /></Field>
        <Field label="Rule" required><Select value={rule} onChange={(v) => { setRule(v); setParams({}); }} options={catalog.map((c) => ({ value: c.rule, label: c.label }))} /></Field>
        {spec?.params.includes("min") && <Field label="Minimum"><Input value={params.min ?? ""} onChange={(e) => setParams({ ...params, min: e.target.value })} placeholder="e.g. 0 or 1900-01-01" /></Field>}
        {spec?.params.includes("max") && <Field label="Maximum"><Input value={params.max ?? ""} onChange={(e) => setParams({ ...params, max: e.target.value })} placeholder="e.g. 100 or today" /></Field>}
        {spec?.params.includes("values") && <Field label="Allowed values" className="sm:col-span-2"><Input value={params.values ?? ""} onChange={(e) => setParams({ ...params, values: e.target.value })} placeholder="Active, Inactive, Pending" /></Field>}
        {spec?.params.includes("pattern") && <Field label="Pattern" className="sm:col-span-2"><Select value={params.pattern ?? ""} onChange={(v) => setParams({ ...params, pattern: v })} placeholder="Choose" options={[{ value: "^[A-Z]{2}\\d+$", label: "Two letters then digits (AB123)" }, { value: "^\\d{5}$", label: "Five digits (ZIP)" }, { value: "^[A-Z0-9-]+$", label: "Uppercase code" }]} /></Field>}
        {spec?.params.includes("length") && <Field label="Minimum length"><Input type="number" value={params.length ?? ""} onChange={(e) => setParams({ ...params, length: e.target.value })} /></Field>}
        {spec?.params.includes("dataset_id") && (
          <>
            <Field label="Must exist in dataset"><Select value={params.dataset_id ?? ""} onChange={(v) => setParams({ ...params, dataset_id: v })} placeholder="Choose" options={others.map((d) => ({ value: d.id, label: d.name }))} /></Field>
            <Field label="Column in that dataset"><Input value={params.column ?? ""} onChange={(e) => setParams({ ...params, column: e.target.value })} placeholder="customer_id" /></Field>
          </>
        )}
        <Field label="When a record fails" className="sm:col-span-2">
          <Select value={onFail} onChange={setOnFail} options={[{ value: "warn", label: "Keep it and warn" }, { value: "drop", label: "Drop it from Silver" }, { value: "quarantine", label: "Quarantine for review" }, { value: "fail", label: "Stop the pipeline" }]} />
        </Field>
      </div>
    </Dialog>
  );
}

export function QualityPanel({ pipeline, mutate }: { pipeline: Pipeline; mutate: (l: string, fn: () => Promise<Pipeline>, o?: { success?: string }) => Promise<unknown> }) {
  const meta = pipeline.metadata;
  const { data, loading, reload } = useApi<QualityData>(`/api/pipelines/${pipeline.id}/quality`, [meta.quality_rules.length, meta.transformations.length]);
  const [ds, setDs] = useState<string>(meta.source.datasets.find((d) => d.selected)?.id ?? "");
  const [creating, setCreating] = useState(false);
  const cur = data?.datasets.find((d) => d.dataset_id === ds) ?? data?.datasets[0];
  const rules = meta.quality_rules.filter((r) => r.dataset_id === (cur?.dataset_id ?? ds));
  const resultOf = (id: string) => cur?.after.rules.find((r) => r.rule_id === id);
  const radar = DIMS.filter((d) => cur && (cur.after.dimensions[d] !== undefined || cur.before.dimensions[d] !== undefined)).map((d) => ({ dim: humanize(d), before: cur!.before.dimensions[d] ?? 100, after: cur!.after.dimensions[d] ?? 100 }));
  const setRule = (id: string, patch: Record<string, unknown>) => mutate("rule", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}/quality-rules/${id}`, patch)).then(reload);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={cur?.dataset_id ?? ds} onValueChange={setDs}>
          <TabsList>
            {(data?.datasets ?? []).map((d) => <TabsTrigger key={d.dataset_id} value={d.dataset_id}>{d.dataset.split(" › ").pop()}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <Button variant="primary" onClick={() => setCreating(true)}><Plus /> Create Rule</Button>
      </div>
      {loading && !data ? <Skeleton className="h-72" /> : cur && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card className="flex items-center gap-4 p-4">
              <ScoreRing score={cur.after.score ?? undefined} size={72} label="score" />
              <div><div className="text-xs text-slate-500">Rules pass rate</div><div className="text-sm text-slate-700">before: <b>{cur.before.score ?? "—"}%</b></div></div>
            </Card>
            <Card className="p-4"><div className="text-xs text-slate-500">Rules enabled</div><div className="mt-1 text-2xl font-semibold">{rules.filter((r) => r.enabled).length}</div><div className="text-xs text-slate-400">{rules.filter((r) => r.origin === "ai").length} recommended by AI</div></Card>
            <Card className="p-4"><div className="text-xs text-slate-500">Records failing a rule</div><div className="mt-1 text-2xl font-semibold">{fmtNumber(cur.after.failing_records)}</div><div className="text-xs text-slate-400">was {fmtNumber(cur.before.failing_records)} before transformations</div></Card>
            <Card className="p-4"><div className="text-xs text-slate-500">Anomalies (outliers)</div><div className="mt-1 text-2xl font-semibold">{cur.anomalies.reduce((s, a) => s + a.outliers, 0)}</div><div className="text-xs text-slate-400">{cur.anomalies.map((a) => a.column).join(", ") || "none detected"}</div></Card>
          </div>
          <div className="grid gap-5 xl:grid-cols-3">
            <Card className="p-5">
              <div className="mb-1 font-semibold">Quality dimensions</div>
              <div className="text-xs text-slate-500">Rule pass rate by dimension: before vs. after transformations</div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radar} outerRadius="70%">
                    <PolarGrid stroke="#e2e8f0" />
                    <PolarAngleAxis dataKey="dim" tick={{ fontSize: 10, fill: "#64748b" }} />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} formatter={(v) => `${v}%`} />
                    <Radar name="Before" dataKey="before" stroke="#94a3b8" fill="#94a3b8" fillOpacity={0.15} />
                    <Radar name="After" dataKey="after" stroke="#6366f1" fill="#6366f1" fillOpacity={0.3} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-center gap-4 text-xs text-slate-500"><span className="flex items-center gap-1"><span className="size-2 rounded-full bg-slate-400" /> Before</span><span className="flex items-center gap-1"><span className="size-2 rounded-full bg-brand-500" /> After</span></div>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader title="Rules" description="Evaluated on the transformed data. Rules become Lakeflow expectations on Databricks." icon={<ShieldCheck />} />
              <div className="max-h-[420px] divide-y divide-slate-50 overflow-y-auto scrollbar-thin">
                {rules.map((r) => {
                  const res = resultOf(r.id);
                  return (
                    <div key={r.id} className={cn("flex items-center gap-3 px-5 py-2.5", !r.enabled && "opacity-50")}>
                      {!r.enabled ? <span className="size-4" /> : res?.status === "passed" ? <CircleCheck className="size-4 text-emerald-500" /> : res?.status === "failed" ? <TriangleAlert className="size-4 text-amber-500" /> : <CircleX className="size-4 text-rose-500" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm text-slate-800">{r.description}{r.origin === "ai" && <AIBadge />}</div>
                        <div className="text-xs text-slate-500">
                          <Badge className="mr-1">{humanize(r.dimension)}</Badge>
                          {res?.status === "error" ? <span className="text-rose-600">{res.message}</span> : res ? `${res.pass_rate}% pass · ${fmtNumber(res.failed)} failing` : "—"}
                          {res?.examples && res.examples.length > 0 && <span className="ml-1 font-mono text-slate-400">e.g. {res.examples.slice(0, 2).join(", ")}</span>}
                        </div>
                      </div>
                      <Select className="w-36" value={r.on_fail} onChange={(v) => setRule(r.id, { on_fail: v })} options={[{ value: "warn", label: "Warn" }, { value: "drop", label: "Drop record" }, { value: "quarantine", label: "Quarantine" }, { value: "fail", label: "Stop pipeline" }]} />
                      <Switch checked={r.enabled} onCheckedChange={(v) => setRule(r.id, { enabled: v })} />
                      <Button variant="ghost" size="icon" aria-label="Delete rule" onClick={() => mutate("rule", () => api.del<Pipeline>(`/api/pipelines/${pipeline.id}/quality-rules/${r.id}`)).then(reload)}><Trash2 /></Button>
                    </div>
                  );
                })}
                {rules.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-500"><Sparkles className="mx-auto mb-2 size-5 text-ai-500" />No rules yet. Run the analysis to get AI-recommended rules, or create one.</div>}
              </div>
            </Card>
          </div>
        </>
      )}
      {data && cur && <CreateRule open={creating} onOpenChange={setCreating} pipeline={pipeline} datasetId={cur.dataset_id} catalog={data.catalog} onCreate={async (r) => { await mutate("rule", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/quality-rules`, r), { success: "Rule created" }); setCreating(false); void reload(); }} />}
    </div>
  );
}
