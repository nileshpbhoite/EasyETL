"use client";

import { Activity, ArrowRight, CircleCheck, CircleX, Clock, Database, DollarSign, Gauge, HardDrive, Pause, Play, RefreshCw, Sparkles, TriangleAlert, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { AIBadge, Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Skeleton, Stat, StatusBadge } from "@/components/ui";
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

function FlowStatus({ layers, status, engine }: { layers: Record<string, number>; status: string; engine: string }) {
  const failed = status === "failed";
  const stages = [
    { key: "source", label: "Source", icon: Database },
    { key: "ingestion", label: engine, icon: Zap },
    { key: "bronze", label: "Bronze", icon: CircleCheck },
    { key: "silver", label: "Silver", icon: CircleCheck },
    { key: "gold", label: "Gold", icon: CircleCheck },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {stages.map((s, i) => {
        const count = s.key === "ingestion" ? layers.bronze : layers[s.key];
        const bad = failed && ["silver", "gold"].includes(s.key);
        return (
          <div key={s.key} className="flex items-center gap-2">
            <div className={cn("min-w-[130px] rounded-xl border px-3 py-2.5", bad ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50/60")}>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                {bad ? <CircleX className="size-4 text-rose-500" /> : <s.icon className="size-4 text-emerald-600" />} {s.label} {!bad && s.key !== "source" && s.key !== "ingestion" && "✓"}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">{bad ? "skipped" : `${fmtNumber(count)} records`}</div>
            </div>
            {i < stages.length - 1 && <ArrowRight className="size-4 text-slate-300" />}
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

export function MonitoringDashboard({ pipelineId, embedded }: { pipelineId: string; embedded?: boolean }) {
  const { data, error, loading, reload } = useApi<Monitoring>(`/api/pipelines/${pipelineId}/monitoring`);
  const [acting, setActing] = useState<string | null>(null);
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
    records: r.records_ingested, quality: r.quality_score, duration: Math.round(r.duration_seconds), failed: r.status === "failed" ? 1 : 0, cost: r.cost_usd,
  }));
  const engine = { auto_loader: "Auto Loader", lakeflow_connect: "Lakeflow Connect", rest_api: "API ingestion", jdbc: "JDBC", batch: "Batch", streaming: "Streaming" }[data.pipeline.ingestion_engine ?? ""] ?? "Ingestion";

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-center gap-3">
        {!embedded && <h2 className="text-xl font-semibold">{data.pipeline.name}</h2>}
        <StatusBadge status={s.status} />
        <span className="text-sm text-slate-500">Last run {timeAgo(s.last_run.started_at)} · next {s.next_run ? timeAgo(s.next_run) : "—"} · {s.success_rate}% success · {data.deployment.target_environment}</span>
        {data.deployment.mode === "mock" && <Badge tone="sky">Simulation</Badge>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => reload()}><RefreshCw /> Refresh</Button>
          <Button size="sm" variant="secondary" onClick={() => act("run-now")} loading={acting === "run-now"}><Play /> Run now</Button>
          {s.status === "paused" ? <Button size="sm" variant="primary" onClick={() => act("resume")} loading={acting === "resume"}><Play /> Resume</Button> : <Button size="sm" variant="secondary" onClick={() => act("pause")} loading={acting === "pause"}><Pause /> Pause</Button>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 2xl:grid-cols-8">
        <Stat label="Records ingested" value={fmtCompact(s.records_last_run)} sub={`${fmtCompact(s.records_24h)} in 24h`} icon={<Database />} />
        <Stat label="Processing time" value={fmtDuration(s.processing_seconds)} sub="last run" icon={<Clock />} tone="sky" />
        <Stat label="Throughput" value={fmtCompact(s.throughput_rps)} sub="records / sec" icon={<Zap />} tone="ai" />
        <Stat label="Data freshness" value={fmtMinutes(s.freshness_minutes)} sub="since last load" icon={<Activity />} tone="amber" />
        <Stat label="Data quality" value={s.quality_score ? `${s.quality_score}%` : "—"} sub="rules pass rate" icon={<Gauge />} tone="green" />
        <Stat label="Failed records" value={fmtNumber(s.failed_records)} sub="quarantined" icon={<TriangleAlert />} tone={s.failed_records ? "red" : "slate"} />
        <Stat label="Storage" value={`${(s.storage_gb ?? 0).toFixed(2)} GB`} sub="all layers" icon={<HardDrive />} tone="slate" />
        <Stat label="Cost (MTD)" value={fmtMoney(s.cost_mtd_usd)} sub="estimated" icon={<DollarSign />} tone="slate" />
      </div>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between"><div className="font-semibold">Pipeline status · latest run</div><span className="text-xs text-slate-500">{new Date(s.last_run.started_at).toLocaleString()}</span></div>
        <FlowStatus layers={s.layers ?? {}} status={s.last_run.status} engine={engine} />
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card className="p-5">
            <div className="font-semibold">Records ingested per run</div>
            <div className="text-xs text-slate-500">Last {series.length} runs</div>
            <div className="mt-3 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                  <defs><linearGradient id="rec" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} /><stop offset="100%" stopColor="#6366f1" stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid vertical={false} stroke="#eef0f5" />
                  <XAxis dataKey="t" tick={tick} tickLine={false} axisLine={false} minTickGap={40} />
                  <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => fmtCompact(v)} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => [fmtNumber(Number(v)), "Records"]} />
                  <Area type="monotone" dataKey="records" stroke="#6366f1" strokeWidth={2} fill="url(#rec)" dot={false} activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="p-5">
              <div className="font-semibold">Data quality</div>
              <div className="text-xs text-slate-500">% of records passing all rules</div>
              <div className="mt-3 h-44">
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
            </Card>
            <Card className="p-5">
              <div className="font-semibold">Processing time</div>
              <div className="text-xs text-slate-500">Seconds per run</div>
              <div className="mt-3 h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 5, right: 5, left: -18, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f5" />
                    <XAxis dataKey="t" tick={tick} tickLine={false} axisLine={false} minTickGap={50} />
                    <YAxis tick={tick} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#eef2ff" }} formatter={(v) => [`${v}s`, "Duration"]} />
                    <Bar dataKey="duration" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>
        </div>
        <Card className="overflow-hidden">
          <div className="ai-surface border-b border-ai-100 px-5 py-4">
            <div className="flex items-center gap-2 font-semibold text-ai-900"><Sparkles className="size-4 text-ai-600" /> AI Continuous Monitoring <AIBadge label={`${data.alerts.length}`} /></div>
            <div className="mt-0.5 text-xs text-ai-800/70">Volume, schema, quality, freshness, performance & cost anomalies</div>
          </div>
          <div className="max-h-[560px] space-y-3 overflow-y-auto p-4 scrollbar-thin">
            {data.alerts.length === 0 && <div className="py-10 text-center text-sm text-slate-500"><CircleCheck className="mx-auto mb-2 size-6 text-emerald-500" />No anomalies detected. Everything is within normal ranges.</div>}
            {data.alerts.map((a) => <AlertCard key={a.id} a={a} />)}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Run history" description={`${s.run_count} runs`} icon={<Activity />} />
        <div className="max-h-96 overflow-y-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white"><tr className="border-b border-slate-100 text-left text-xs text-slate-400"><th className="px-5 py-2 font-medium">Started</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Records</th><th className="px-3 py-2 text-right font-medium">Failed</th><th className="px-3 py-2 text-right font-medium">Duration</th><th className="px-3 py-2 text-right font-medium">Quality</th><th className="px-5 py-2 text-right font-medium">Cost</th></tr></thead>
            <tbody>
              {[...data.runs].reverse().slice(0, 50).map((r) => (
                <tr key={r.id} className="border-b border-slate-50">
                  <td className="px-5 py-2 text-slate-600">{new Date(r.started_at).toLocaleString()}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.status} />{r.details.error && <span className="ml-2 text-xs text-rose-600">{r.details.error.title}</span>}{r.details.schema_change && <Badge tone="sky" className="ml-2">schema change</Badge>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNumber(r.records_ingested)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtNumber(r.failed_records)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtDuration(r.duration_seconds)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.quality_score}%</td>
                  <td className="px-5 py-2 text-right tabular-nums text-slate-500">{fmtMoney(r.cost_usd, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
