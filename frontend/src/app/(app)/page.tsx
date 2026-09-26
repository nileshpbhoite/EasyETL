"use client";

import { Activity, ArrowRight, CircleCheck, Clock, Database, DollarSign, FileUp, Gauge, LayoutTemplate, Library, Plug, Plus, Sparkles, TriangleAlert, Upload, Workflow, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { AIBadge, Button, Card, CardHeader, EmptyState, ErrorBox, Skeleton, Stat, StatusBadge } from "@/components/ui";
import { getStoredUser } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Alert, PipelineSummary } from "@/lib/types";
import { cn, fmtCompact, fmtMinutes, fmtMoney, qualityColor, timeAgo } from "@/lib/utils";
import { createPipelineFromFiles } from "@/components/source/upload";

interface Dashboard {
  metrics: {
    active_pipelines: number;
    total_pipelines: number;
    data_sources: number;
    records_24h: number;
    quality_score: number | null;
    failed_pipelines: number;
    freshness_minutes: number | null;
    estimated_monthly_cost: number;
  };
  recent_pipelines: PipelineSummary[];
  insights: Alert[];
}

const QUICK = [
  { href: "/sources", icon: Plug, title: "Connect Data", desc: "Salesforce, SAP, SQL Server, APIs…", color: "from-sky-500 to-brand-500" },
  { href: "#upload", icon: Upload, title: "Upload File", desc: "Excel, CSV, JSON, XML, ZIP", color: "from-brand-500 to-ai-500" },
  { href: "/pipelines/new", icon: Workflow, title: "Create Pipeline", desc: "Guided, AI-assisted wizard", color: "from-ai-500 to-fuchsia-500" },
  { href: "/templates", icon: LayoutTemplate, title: "Use Template", desc: "Customer 360, Sales, Finance…", color: "from-emerald-500 to-teal-500" },
  { href: "/catalog", icon: Library, title: "View Data Catalog", desc: "Tables, lineage, PII & quality", color: "from-amber-500 to-orange-500" },
];

function InsightRow({ a }: { a: Alert }) {
  const Icon = a.severity === "critical" ? TriangleAlert : a.severity === "warning" ? TriangleAlert : a.kind === "recommendations" ? Sparkles : CircleCheck;
  return (
    <Link href={a.pipeline_id ? (a.kind === "recommendations" ? `/pipelines/${a.pipeline_id}?step=analyze` : `/monitoring?pipeline=${a.pipeline_id}`) : "/monitoring"} className="group flex gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-white/70">
      <Icon className={cn("mt-0.5 size-4 shrink-0", a.severity === "critical" ? "text-rose-500" : a.severity === "warning" ? "text-amber-500" : "text-ai-500")} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-800">{a.title}</div>
        {(a.recommendation || a.pipeline_name) && (
          <div className="mt-0.5 text-xs text-slate-500">
            {a.pipeline_name && <span className="font-medium text-slate-600">{a.pipeline_name}</span>}
            {a.pipeline_name && a.recommendation && " · "}
            {a.recommendation}
          </div>
        )}
      </div>
      <ArrowRight className="mt-0.5 size-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500" />
    </Link>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { data, error, loading, reload } = useApi<Dashboard>("/api/dashboard");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const user = typeof window !== "undefined" ? getStoredUser() : null;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      const id = await createPipelineFromFiles(list);
      router.push(`/pipelines/${id}?step=source`);
    } catch (e) {
      toast.error("Upload failed", { description: (e as Error).message });
      setUploading(false);
    }
  };

  const m = data?.metrics;
  return (
    <div
      className="relative min-h-full"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void handleFiles(e.dataTransfer.files);
      }}
    >
      {(dragging || uploading) && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-brand-600/10 backdrop-blur-sm md:left-[248px]">
          <div className="rounded-2xl border-2 border-dashed border-brand-400 bg-white/90 px-12 py-10 text-center shadow-lift">
            <FileUp className="mx-auto size-10 text-brand-600" />
            <div className="mt-3 text-lg font-semibold">{uploading ? "Uploading & detecting…" : "Drop anything here"}</div>
            <div className="text-sm text-slate-500">We'll create a pipeline and analyze it automatically</div>
          </div>
        </div>
      )}
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && handleFiles(e.target.files)} />

      <div className="gradient-hero border-b border-slate-200/60 bg-white">
        <div className="mx-auto max-w-[1400px] px-6 py-8 md:px-8">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <div className="text-sm font-medium text-brand-600">{greeting}{user?.name ? `, ${user.name.split(" ")[0]}` : ""}</div>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">Connect any data. AI understands it. Deploy it to Databricks.</h1>
              <p className="mt-2 max-w-2xl text-slate-500">Drop a file anywhere on this page, or start a guided pipeline. No code — ever.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="lg" onClick={() => fileInput.current?.click()}>
                <Upload /> Upload a file
              </Button>
              <Link href="/pipelines/new">
                <Button variant="primary" size="lg">
                  <Plus /> Create Pipeline
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-6 md:px-8">
        <ErrorBox error={error} onRetry={reload} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {loading || !m ? (
            Array.from({ length: 7 }).map((_, i) => (
              <Card key={i} className="p-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-3 h-7 w-16" />
              </Card>
            ))
          ) : (
            <>
              <Stat label="Active Pipelines" value={m.active_pipelines} sub={`${m.total_pipelines} total`} icon={<Workflow />} />
              <Stat label="Data Sources" value={m.data_sources} sub="connected" icon={<Database />} tone="sky" />
              <Stat label="Records Processed" value={fmtCompact(m.records_24h)} sub="last 24 hours" icon={<Zap />} tone="ai" />
              <Stat label="Data Quality Score" value={<span className={qualityColor(m.quality_score)}>{m.quality_score ? `${m.quality_score}%` : "—"}</span>} sub="across deployed pipelines" icon={<Gauge />} tone="green" />
              <Stat label="Failed Pipelines" value={<span className={m.failed_pipelines ? "text-rose-600" : ""}>{m.failed_pipelines}</span>} sub={m.failed_pipelines ? "needs attention" : "all healthy"} icon={<TriangleAlert />} tone={m.failed_pipelines ? "red" : "slate"} />
              <Stat label="Data Freshness" value={fmtMinutes(m.freshness_minutes)} sub="oldest successful load" icon={<Clock />} tone="amber" />
              <Stat label="Est. Databricks Cost" value={fmtMoney(m.estimated_monthly_cost, 0)} sub="per month" icon={<DollarSign />} tone="slate" />
            </>
          )}
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          <Card className="overflow-hidden xl:col-span-1">
            <div className="ai-surface border-b border-ai-100 px-5 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-ai-900">
                  <Sparkles className="size-4 text-ai-600" /> AI Insights
                </div>
                <AIBadge label="Live" />
              </div>
              <p className="mt-0.5 text-xs text-ai-800/70">Continuous monitoring across all pipelines</p>
            </div>
            <div className="ai-surface/40 space-y-0.5 p-2">
              {loading && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="m-3 h-4" />)}
              {data?.insights.length === 0 && <div className="px-3 py-8 text-center text-sm text-slate-500">Everything looks healthy. ✨</div>}
              {data?.insights.map((a) => <InsightRow key={a.id} a={a} />)}
            </div>
          </Card>

          <div className="grid h-fit grid-cols-2 gap-3 sm:grid-cols-3 xl:col-span-2 xl:grid-cols-3">
            {QUICK.map((q) => (
              <button
                key={q.title}
                onClick={() => (q.href === "#upload" ? fileInput.current?.click() : router.push(q.href))}
                className="group relative overflow-hidden rounded-xl border border-slate-200/80 bg-white p-5 text-left shadow-card transition-all hover:-translate-y-0.5 hover:shadow-lift"
              >
                <div className={cn("flex size-10 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md", q.color)}>
                  <q.icon className="size-5" />
                </div>
                <div className="mt-4 font-semibold text-slate-900">{q.title}</div>
                <div className="mt-0.5 text-sm text-slate-500">{q.desc}</div>
                <ArrowRight className="absolute right-4 top-5 size-4 text-slate-300 transition-all group-hover:translate-x-0.5 group-hover:text-brand-500" />
              </button>
            ))}
            <div className="flex flex-col justify-between rounded-xl bg-navy-900 p-5 text-white shadow-card">
              <Activity className="size-5 text-brand-300" />
              <div>
                <div className="mt-4 font-semibold">Monitoring</div>
                <div className="text-sm text-slate-400">Runs, freshness & anomalies</div>
              </div>
              <Link href="/monitoring" className="mt-3 text-sm font-medium text-brand-300 hover:text-brand-200">
                Open monitoring →
              </Link>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader
            title="Recent pipelines"
            description="Your latest work across all environments"
            icon={<Workflow />}
            actions={
              <Link href="/pipelines">
                <Button variant="ghost" size="sm">
                  View all <ArrowRight />
                </Button>
              </Link>
            }
          />
          {data && data.recent_pipelines.length === 0 ? (
            <EmptyState icon={<Workflow />} title="No pipelines yet" description="Drop a file anywhere on this page or create your first pipeline." action={<Link href="/pipelines/new"><Button variant="primary"><Plus /> Create Pipeline</Button></Link>} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                    <th className="px-5 py-2.5">Pipeline</th>
                    <th className="px-3 py-2.5">Source</th>
                    <th className="px-3 py-2.5">Target</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Last run</th>
                    <th className="px-3 py-2.5">Next run</th>
                    <th className="px-3 py-2.5 text-right">Records</th>
                    <th className="px-5 py-2.5 text-right">Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.recent_pipelines ?? []).map((p) => (
                    <tr key={p.id} onClick={() => router.push(p.deployment_status === "deployed" ? `/monitoring?pipeline=${p.id}` : `/pipelines/${p.id}`)} className="cursor-pointer border-b border-slate-50 transition-colors hover:bg-slate-50/80">
                      <td className="px-5 py-3">
                        <div className="font-medium text-slate-900">{p.name}</div>
                        <div className="text-xs text-slate-500">{p.environment}</div>
                      </td>
                      <td className="px-3 py-3 text-slate-600">{p.source_label}</td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-600">{p.target_label}</td>
                      <td className="px-3 py-3">
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="px-3 py-3 text-slate-600">{p.last_run ? timeAgo(p.last_run.started_at) : "—"}</td>
                      <td className="px-3 py-3 text-slate-600">{p.next_run ? timeAgo(p.next_run) : "—"}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-700">{fmtCompact(p.records_processed)}</td>
                      <td className={cn("px-5 py-3 text-right font-semibold tabular-nums", qualityColor(p.quality_score))}>{p.quality_score ? `${p.quality_score}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
