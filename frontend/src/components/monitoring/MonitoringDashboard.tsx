"use client";

import { Activity, ArrowRight, CircleCheck, CircleX, Clock, Database, DollarSign, ExternalLink, Gauge, HardDrive, Pause, Play, RefreshCw, Sparkles, TriangleAlert, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { AIBadge, Badge, Button, Card, EmptyState, ErrorBox, Skeleton, Stat, StatusBadge } from "@/components/ui";
import { Cylinder } from "@/components/lakehouse/Cylinder";
import { FileTypeIcon } from "@/components/source/FileTypeIcon";
import { LineTabs, SectionCard } from "@/components/wizard/common";
import { api } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import type { Alert, DeploymentState, PipelineSummary, Run } from "@/lib/types";
import { cn, fmtCompact, fmtDuration, fmtMinutes, fmtMoney, fmtNumber, timeAgo } from "@/lib/utils";

interface Monitoring {
  summary: {
    status: string;
    last_run?: Run;
    next_run?: string | null;
    records_last_run?: number;
    records_24h?: number;
    processing_seconds?: number;
    throughput_rps?: number;
    freshness_minutes?: number | null;
    quality_score?: number | null;
    failed_records?: number;
    storage_gb?: number;
    cost_mtd_usd?: number;
    success_rate?: number;
    layers?: Record<string, number>;
    run_count?: number;
  };
  runs: Run[];
  alerts: Alert[];
  deployment: DeploymentState;
  pipeline: PipelineSummary;
}

const tick = { fontSize: 10, fill: "#94a3b8" };
const tooltipStyle = { borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, boxShadow: "0 8px 24px -6px rgb(15 23 42 / .12)" };

function when(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((day - today) / 86400000);
  const label = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${label}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function sourceFormat(p: PipelineSummary) {
  if (p.source_format) return p.source_format;
  const ext = /\.(xlsx|xls|csv|json|xml|parquet|avro|txt|zip)\b/i.exec(p.source_label ?? "")?.[1]?.toLowerCase();
  if (ext) return ext === "xls" ? "xlsx" : ext;
  if (p.source_category === "database" || p.source_category === "application") return "table";
  if (p.source_category === "api") return "api";
  return p.source_connector ?? "table";
}

function StatusTile({ label, value, sub, tone = "slate" }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "green" | "red" | "amber" | "slate" }) {
  const color = { green: "text-emerald-600", red: "text-rose-600", amber: "text-amber-600", slate: "text-slate-900" }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={cn("mt-1 text-base font-semibold", color)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function SparkTile({ title, value, sub, data, dataKey, color, fmt }: { title: string; value: string; sub: string; data: Record<string, number | string>[]; dataKey: string; color: string; fmt: (v: number) => string }) {
  const gid = `spark-${dataKey}`;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      <div className="mt-1 flex items-baseline gap-2"><span className="text-2xl font-semibold tabular-nums text-slate-900">{value}</span><span className="text-xs text-slate-500">{sub}</span></div>
      <div className="mt-2 h-16">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.3} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(_, p) => String(p?.[0]?.payload?.t ?? "")} formatter={(v) => [fmt(Number(v)), title]} />
            <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#${gid})`} dot={false} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PipelineFlow({ layers, status, engine, format }: { layers: Record<string, number>; status: string; engine: string; format: string }) {
  const failed = status === "failed";
  const nodes: { key: string; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: "source", label: "Source", icon: <FileTypeIcon format={format} size={34} />, count: layers.source },
    { key: "ingestion", label: engine, icon: <div className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><Zap className="size-5" /></div> },
    { key: "bronze", label: "Bronze", icon: <Cylinder layer="bronze" size={42} />, count: layers.bronze },
    { key: "silver", label: "Silver", icon: <Cylinder layer="silver" size={42} />, count: layers.silver },
    { key: "gold", label: "Gold", icon: <Cylinder layer="gold" size={42} />, count: layers.gold },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {nodes.map((n, i) => {
        const bad = failed && ["silver", "gold"].includes(n.key);
        return (
          <div key={n.key} className="flex items-center gap-2">
            <div className={cn("flex min-w-[112px] flex-col items-center gap-1.5 rounded-xl border px-3 py-3", bad ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-white")}>
              {n.icon}
              <div className="flex items-center gap-1 text-[13px] font-semibold text-slate-800">
                {n.label} {bad ? <CircleX className="size-3.5 text-rose-500" /> : <CircleCheck className="size-3.5 text-emerald-500" />}
              </div>
              <div className="text-[11px] text-slate-500">{bad ? "skipped" : n.count != null ? `${fmtCompact(n.count)} records` : "healthy"}</div>
            </div>
            {i < nodes.length - 1 && <ArrowRight className="size-4 text-slate-300" />}
          </div>
        );
      })}
    </div>
  );
}

export function AlertCard({ a, compact }: { a: Alert; compact?: boolean }) {
  const tone = a.severity === "critical" ? "border-rose-200 bg-rose-50/60" : a.severity === "warning" ? "border-amber-200 bg-amber-50/60" : "border-ai-100 ai-surface";
  return (
    <div className={cn("rounded-xl border p-4", tone)}>
      <div className="flex gap-3">
        {a.severity === "info" ? <Sparkles className="mt-0.5 size-4 shrink-0 text-ai-600" /> : <TriangleAlert className={cn("mt-0.5 size-4 shrink-0", a.severity === "critical" ? "text-rose-500" : "text-amber-500")} />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900">{a.severity !== "info" && "⚠ "}{a.title}</div>
          {a.detail && !compact && <div className="mt-0.5 text-sm text-slate-600">{a.detail}</div>}
          <div className="mt-2 text-sm"><span className="font-semibold text-ai-800">Recommendation: </span><span className="text-slate-700">{a.recommendation}</span></div>
          <div className="mt-1.5 text-xs text-slate-400">{a.detected_at && timeAgo(a.detected_at)} · {a.kind}</div>
        </div>
      </div>
    </div>
  );
}

type Tab = "overview" | "runs" | "data" | "quality" | "monitoring";

export function MonitoringDashboard({ pipelineId, embedded }: { pipelineId: string; embedded?: boolean }) {
  const { data, error, loading, reload } = useApi<Monitoring>(`/api/pipelines/${pipelineId}/monitoring`);
  const [acting, setActing] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const act = async (action: "pause" | "resume" | "run-now") => {
    setActing(action);
    try {
      await api.post(`/api/pipelines/${pipelineId}/${action}`);
      toast.success(action === "run-now" ? "Run completed" : action === "pause" ? "Pipeline paused" : "Pipeline resumed");
      await reload();
    } catch (e) {
      showError(e);
    } finally {
      setActing(null);
    }
  };
  if (loading && !data) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-72" /></div>;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  const s = data.summary;
  if (data.deployment.status !== "deployed" || !s.last_run)
    return <Card><EmptyState icon={<Activity />} title="Not deployed yet" description="Deploy this pipeline to Databricks to see runs, freshness, quality and AI alerts here." action={<Link href={`/pipelines/${pipelineId}?step=review`}><Button variant="primary">Review & deploy</Button></Link>} /></Card>;

  const series = data.runs.map((r) => ({
    t: new Date(r.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" }),
    records: r.records_ingested,
    quality: r.quality_score,
    duration: Math.round(r.duration_seconds),
    rpm: r.duration_seconds > 0 ? Math.round((r.records_ingested / r.duration_seconds) * 60) : 0,
    cost: r.cost_usd,
  }));
  const recent = series.slice(-24);
  const engine = { auto_loader: "Auto Loader", lakeflow_connect: "Lakeflow Connect", rest_api: "API ingestion", jdbc: "JDBC", batch: "Batch", streaming: "Streaming" }[data.pipeline.ingestion_engine ?? ""] ?? "Ingestion";
  const lastRpm = recent.at(-1)?.rpm ?? 0;
  const failed = s.last_run.status === "failed";
  const paused = s.status === "paused";
  const workspace = data.deployment.workspace_url;
  const critical = data.alerts.filter((a) => a.severity !== "info").length;

  const actions = (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={() => reload()}><RefreshCw /> Refresh</Button>
      <Button size="sm" variant="secondary" onClick={() => act("run-now")} loading={acting === "run-now"}><Play /> Run now</Button>
      {paused ? <Button size="sm" variant="primary" onClick={() => act("resume")} loading={acting === "resume"}><Play /> Resume</Button> : <Button size="sm" variant="secondary" onClick={() => act("pause")} loading={acting === "pause"}><Pause /> Pause</Button>}
    </div>
  );

  return (
    <SectionCard
      icon={<Activity />}
      title={embedded ? "Pipeline Deployed" : data.pipeline.name}
      subtitle="Live health, runs, data volume, quality and AI anomaly detection"
      actions={actions}
      className="animate-fade-in"
    >
      <div className={cn("mb-5 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3", failed ? "border-rose-200 bg-rose-50" : paused ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50")}>
        <div className={cn("grid size-9 place-items-center rounded-full text-white", failed ? "bg-rose-500" : paused ? "bg-amber-500" : "bg-emerald-500")}>
          {failed ? <CircleX className="size-5" /> : paused ? <Pause className="size-5" /> : <CircleCheck className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn("font-semibold", failed ? "text-rose-800" : paused ? "text-amber-800" : "text-emerald-800")}>
            {failed ? "Last run failed" : paused ? "Pipeline is paused" : "Your pipeline is live and running successfully!"}
          </div>
          <div className="text-xs text-slate-600">
            {failed ? s.last_run.details.error?.title ?? "See the AI alerts for a suggested fix." : `Deployed to ${data.deployment.target_environment} · ${s.success_rate}% success rate across ${s.run_count} runs`}
            {data.deployment.mode === "mock" && <Badge tone="sky" className="ml-2">Simulation</Badge>}
          </div>
        </div>
        {workspace ? (
          <a href={workspace} target="_blank" rel="noreferrer"><Button size="sm" variant="primary"><ExternalLink /> Open in Databricks</Button></a>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => toast.info("Simulation mode — connect a Databricks workspace in Settings to open it there.")}><ExternalLink /> Open in Databricks</Button>
        )}
      </div>

      <LineTabs<Tab>
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "runs", label: `Runs (${s.run_count ?? data.runs.length})` },
          { value: "data", label: "Data" },
          { value: "quality", label: "Quality" },
          { value: "monitoring", label: <span className="inline-flex items-center gap-1.5">Monitoring {critical > 0 && <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white">{critical}</span>}</span> },
        ]}
      />

      {tab === "overview" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatusTile label="Status" value={<span className="inline-flex items-center gap-1.5"><span className={cn("size-2 rounded-full", failed ? "bg-rose-500" : paused ? "bg-amber-500" : "bg-emerald-500")} />{failed ? "Failed" : paused ? "Paused" : "Active"}</span>} tone={failed ? "red" : paused ? "amber" : "green"} />
            <StatusTile label="Last Run" value={when(s.last_run.started_at)} sub={`${fmtDuration(s.last_run.duration_seconds)} · ${s.last_run.status}`} />
            <StatusTile label="Next Run" value={paused ? "Paused" : when(s.next_run)} sub={data.pipeline.frequency} />
            <StatusTile label="Records Ingested" value={fmtNumber(s.records_last_run)} sub={`${fmtCompact(s.records_24h)} in last 24h`} />
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-3 flex items-center justify-between"><div className="text-sm font-semibold text-slate-800">Pipeline Flow</div><span className="text-xs text-slate-500">Latest run · {new Date(s.last_run.started_at).toLocaleString()}</span></div>
            <PipelineFlow layers={s.layers ?? {}} status={s.last_run.status} engine={engine} format={sourceFormat(data.pipeline)} />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <SparkTile title="Data Quality" value={s.quality_score ? `${s.quality_score}%` : "—"} sub="rules pass rate" data={recent} dataKey="quality" color="#10b981" fmt={(v) => `${v}%`} />
            <SparkTile title="Freshness" value={fmtMinutes(s.freshness_minutes)} sub="since last load" data={recent} dataKey="duration" color="#f59e0b" fmt={(v) => `${fmtDuration(v)} to land data`} />
            <SparkTile title="Pipeline Performance" value={fmtCompact(lastRpm)} sub="rows / min" data={recent} dataKey="rpm" color="#2659eb" fmt={(v) => `${fmtNumber(v)} rows/min`} />
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800"><Sparkles className="size-4 text-ai-600" /> AI Alerts <AIBadge label={`${data.alerts.length}`} /></div>
            {data.alerts.length === 0 ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-800"><CircleCheck className="mr-1.5 inline size-4" />No anomalies detected. Everything is within normal ranges.</div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {data.alerts.slice(0, 4).map((a) => <AlertCard key={a.id} a={a} compact />)}
              </div>
            )}
            {data.alerts.length > 4 && <button className="mt-2 text-sm font-medium text-brand-600 hover:underline" onClick={() => setTab("monitoring")}>View all {data.alerts.length} alerts →</button>}
          </div>
        </div>
      )}

      {tab === "runs" && (
        <div className="max-h-[560px] overflow-y-auto rounded-xl border border-slate-200 scrollbar-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50"><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="px-4 py-2 font-medium">Started</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Records</th><th className="px-3 py-2 text-right font-medium">Failed</th><th className="px-3 py-2 text-right font-medium">Duration</th><th className="px-3 py-2 text-right font-medium">Quality</th><th className="px-4 py-2 text-right font-medium">Cost</th></tr></thead>
            <tbody>
              {[...data.runs].reverse().slice(0, 100).map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="px-4 py-2 text-slate-600">{new Date(r.started_at).toLocaleString()}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.status} />{r.details.error && <span className="ml-2 text-xs text-rose-600">{r.details.error.title}</span>}{r.details.schema_change && <Badge tone="sky" className="ml-2">schema change</Badge>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNumber(r.records_ingested)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtNumber(r.failed_records)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtDuration(r.duration_seconds)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.quality_score}%</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmtMoney(r.cost_usd, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "data" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Records ingested" value={fmtCompact(s.records_last_run)} sub={`${fmtCompact(s.records_24h)} in 24h`} icon={<Database />} />
            <Stat label="Throughput" value={fmtCompact(s.throughput_rps)} sub="records / sec" icon={<Zap />} tone="ai" />
            <Stat label="Storage" value={`${(s.storage_gb ?? 0).toFixed(2)} GB`} sub="all layers" icon={<HardDrive />} tone="slate" />
            <Stat label="Cost (MTD)" value={fmtMoney(s.cost_mtd_usd)} sub="estimated" icon={<DollarSign />} tone="slate" />
          </div>
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="text-sm font-semibold">Records ingested per run</div>
            <div className="text-xs text-slate-500">Last {series.length} runs</div>
            <div className="mt-3 h-60">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                  <defs><linearGradient id="rec" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2659eb" stopOpacity={0.35} /><stop offset="100%" stopColor="#2659eb" stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid vertical={false} stroke="#eef0f5" />
                  <XAxis dataKey="t" tick={tick} tickLine={false} axisLine={false} minTickGap={40} />
                  <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => fmtCompact(v)} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => [fmtNumber(Number(v)), "Records"]} />
                  <Area type="monotone" dataKey="records" stroke="#2659eb" strokeWidth={2} fill="url(#rec)" dot={false} activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="text-sm font-semibold">Processing time</div>
            <div className="text-xs text-slate-500">Seconds per run</div>
            <div className="mt-3 h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ top: 5, right: 5, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#eef0f5" />
                  <XAxis dataKey="t" tick={tick} tickLine={false} axisLine={false} minTickGap={50} />
                  <YAxis tick={tick} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#eff4ff" }} formatter={(v) => [`${v}s`, "Duration"]} />
                  <Bar dataKey="duration" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {tab === "quality" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Data quality" value={s.quality_score ? `${s.quality_score}%` : "—"} sub="rules pass rate" icon={<Gauge />} tone="green" />
            <Stat label="Failed records" value={fmtNumber(s.failed_records)} sub="quarantined" icon={<TriangleAlert />} tone={s.failed_records ? "red" : "slate"} />
            <Stat label="Data freshness" value={fmtMinutes(s.freshness_minutes)} sub="since last load" icon={<Activity />} tone="amber" />
            <Stat label="Processing time" value={fmtDuration(s.processing_seconds)} sub="last run" icon={<Clock />} tone="sky" />
          </div>
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="text-sm font-semibold">Data quality</div>
            <div className="text-xs text-slate-500">% of records passing all rules</div>
            <div className="mt-3 h-60">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 5, right: 5, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#eef0f5" />
                  <XAxis dataKey="t" tick={tick} tickLine={false} axisLine={false} minTickGap={50} />
                  <YAxis tick={tick} tickLine={false} axisLine={false} domain={["dataMin - 3", 100]} tickFormatter={(v) => `${Math.round(v)}`} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v}%`, "Quality"]} />
                  <Line type="monotone" dataKey="quality" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {tab === "monitoring" && (
        <div>
          <div className="mb-3 text-sm text-slate-500">AI continuously watches volume, schema, quality, freshness, performance and cost for anomalies.</div>
          {data.alerts.length === 0 && <div className="py-10 text-center text-sm text-slate-500"><CircleCheck className="mx-auto mb-2 size-6 text-emerald-500" />No anomalies detected. Everything is within normal ranges.</div>}
          <div className="grid gap-3 lg:grid-cols-2">{data.alerts.map((a) => <AlertCard key={a.id} a={a} />)}</div>
        </div>
      )}
    </SectionCard>
  );
}
