"use client";

import { ArrowRight, CircleCheck, Clock, Database, DollarSign, FileUp, Gauge, LayoutTemplate, Plug, Plus, Sparkles, TriangleAlert, Upload, Workflow, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { AIBadge, Button, Card, CardHeader, EmptyState, ErrorBox, Skeleton, StatusBadge } from "@/components/ui";
import { getStoredUser } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { STEPS, type Alert, type PipelineSummary } from "@/lib/types";
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

const START = [
  { href: "#upload", icon: Upload, title: "Upload a file", desc: "Excel, CSV, JSON, XML, ZIP…", color: "from-brand-400 to-brand-600" },
  { href: "/sources", icon: Plug, title: "Connect a system", desc: "Salesforce, SAP, SQL Server, APIs", color: "from-sky-400 to-cyan-600" },
  { href: "/templates", icon: LayoutTemplate, title: "Start from a template", desc: "Customer 360, Sales, Finance…", color: "from-ai-500 to-fuchsia-500" },
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
  const inProgress = (data?.recent_pipelines ?? []).filter((p) => p.deployment_status !== "deployed").slice(0, 3);
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
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-brand-600/10 backdrop-blur-sm md:left-[240px]">
          <div className="rounded-2xl border-2 border-dashed border-brand-400 bg-white/90 px-12 py-10 text-center shadow-lift">
            <FileUp className="mx-auto size-10 text-brand-600" />
            <div className="mt-3 text-lg font-semibold">{uploading ? "Uploading & detecting…" : "Drop anything here"}</div>
            <div className="text-sm text-slate-500">We'll create a pipeline and analyze it automatically</div>
          </div>
        </div>
      )}
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && handleFiles(e.target.files)} />

      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-7 md:px-8">
        {/* Welcome + the three ways to start */}
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-navy-900 via-[#1a2a78] to-brand-700 p-7 text-white shadow-soft md:p-9">
          <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-ai-500/30 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-32 left-1/3 size-80 rounded-full bg-sky-400/20 blur-3xl" />
          <div className="relative">
            <div className="text-sm font-medium text-brand-200">{greeting}{user?.name ? `, ${user.name.split(" ")[0]}` : ""} 👋</div>
            <h1 className="mt-1.5 text-[28px] font-bold leading-tight md:text-[32px]">What would you like to do today?</h1>
            <p className="mt-1.5 max-w-2xl text-[15px] text-slate-300">Bring in any data, let AI clean it up, and publish it to Databricks — no code needed.</p>
            <div className="mt-6 grid gap-3 md:grid-cols-3">
              {START.map((q) => (
                <button
                  key={q.title}
                  onClick={() => (q.href === "#upload" ? fileInput.current?.click() : router.push(q.href))}
                  className="group flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.07] p-4 text-left backdrop-blur transition-all hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.12]"
                >
                  <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg", q.color)}><q.icon className="size-6" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold">{q.title}</span>
                    <span className="block text-[13px] text-slate-300">{q.desc}</span>
                  </span>
                  <ArrowRight className="size-5 shrink-0 text-white/40 transition-all group-hover:translate-x-0.5 group-hover:text-white" />
                </button>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2 text-[12.5px] text-slate-400"><FileUp className="size-3.5" /> Tip: you can drop a file anywhere on this page.</div>
          </div>
        </section>

        <ErrorBox error={error} onRetry={reload} />

        {/* Continue where you left off */}
        {inProgress.length > 0 && (
          <section>
            <div className="mb-3 flex items-end justify-between">
              <div>
                <h2 className="text-[18px] font-bold text-slate-900">Continue where you left off</h2>
                <p className="text-[13px] text-slate-500">Pipelines you started but haven't deployed yet</p>
              </div>
              <Link href="/pipelines" className="text-sm font-semibold text-brand-600 hover:text-brand-700">All pipelines →</Link>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {inProgress.map((p) => {
                const idx = Math.max(0, STEPS.findIndex((s) => s.id === p.current_step));
                const pct = Math.round((Math.max(p.completed_steps.length, idx) / STEPS.length) * 100);
                return (
                  <Link key={p.id} href={`/pipelines/${p.id}`} className="lift group rounded-2xl border border-slate-200/60 bg-white p-5 shadow-card">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-semibold text-slate-900">{p.name}</div>
                        <div className="truncate text-xs text-slate-500">{p.source_label} · edited {timeAgo(p.updated_at)}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">Step {idx + 1} of {STEPS.length}</span>
                    </div>
                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-brand-500" style={{ width: `${Math.max(pct, 6)}%` }} />
                    </div>
                    <div className="mt-3 flex items-center justify-between text-[13px]">
                      <span className="text-slate-500">Next: <span className="font-medium text-slate-700">{STEPS[idx]?.label} · {STEPS[idx]?.hint}</span></span>
                      <span className="flex items-center gap-1 font-semibold text-brand-600">Continue <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" /></span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* At a glance */}
        <section className="rounded-2xl border border-slate-200/60 bg-white shadow-card">
          <div className="grid grid-cols-2 divide-slate-100 sm:grid-cols-4 xl:grid-cols-7 xl:divide-x">
            {loading || !m
              ? Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="p-5"><Skeleton className="h-3 w-20" /><Skeleton className="mt-3 h-7 w-16" /></div>
                ))
              : [
                  { label: "Active pipelines", value: m.active_pipelines, sub: `${m.total_pipelines} total`, icon: Workflow, tone: "text-brand-600 bg-brand-50" },
                  { label: "Data sources", value: m.data_sources, sub: "connected", icon: Database, tone: "text-sky-600 bg-sky-50" },
                  { label: "Records (24h)", value: fmtCompact(m.records_24h), sub: "processed", icon: Zap, tone: "text-ai-600 bg-ai-50" },
                  { label: "Data quality", value: <span className={qualityColor(m.quality_score)}>{m.quality_score ? `${m.quality_score}%` : "—"}</span>, sub: "deployed pipelines", icon: Gauge, tone: "text-emerald-600 bg-emerald-50" },
                  { label: "Failed", value: <span className={m.failed_pipelines ? "text-rose-600" : ""}>{m.failed_pipelines}</span>, sub: m.failed_pipelines ? "needs attention" : "all healthy", icon: TriangleAlert, tone: m.failed_pipelines ? "text-rose-600 bg-rose-50" : "text-slate-500 bg-slate-100" },
                  { label: "Freshness", value: fmtMinutes(m.freshness_minutes), sub: "oldest load", icon: Clock, tone: "text-amber-600 bg-amber-50" },
                  { label: "Est. cost", value: fmtMoney(m.estimated_monthly_cost, 0), sub: "per month", icon: DollarSign, tone: "text-slate-600 bg-slate-100" },
                ].map((k) => (
                  <div key={k.label} className="p-5">
                    <div className="flex items-center gap-2 text-[12.5px] font-medium text-slate-500">
                      <span className={cn("flex size-6 items-center justify-center rounded-md", k.tone)}><k.icon className="size-3.5" /></span>
                      {k.label}
                    </div>
                    <div className="font-display mt-2 text-[24px] font-bold text-slate-900">{k.value}</div>
                    <div className="text-xs text-slate-400">{k.sub}</div>
                  </div>
                ))}
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader
              title="Recent pipelines"
              description="Click a pipeline to open it"
              icon={<Workflow />}
              actions={<Link href="/pipelines"><Button variant="ghost" size="sm">View all <ArrowRight /></Button></Link>}
            />
            {data && data.recent_pipelines.length === 0 ? (
              <EmptyState icon={<Workflow />} title="No pipelines yet" description="Drop a file anywhere on this page or create your first pipeline." action={<Link href="/pipelines/new"><Button variant="primary"><Plus /> Create Pipeline</Button></Link>} />
            ) : (
              <div className="divide-y divide-slate-100">
                {(data?.recent_pipelines ?? []).slice(0, 6).map((p) => (
                  <button key={p.id} onClick={() => router.push(p.deployment_status === "deployed" ? `/monitoring?pipeline=${p.id}` : `/pipelines/${p.id}`)} className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-slate-50/80">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-ai-50 text-brand-600 ring-1 ring-brand-100"><Workflow className="size-5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-slate-900">{p.name}</span>
                      <span className="block truncate text-xs text-slate-500">{p.source_label} → <span className="font-mono">{p.target_label}</span></span>
                    </span>
                    <span className="hidden w-28 text-xs text-slate-500 md:block">{p.last_run ? <>Ran {timeAgo(p.last_run.started_at)}</> : "Not run yet"}</span>
                    <span className={cn("hidden w-14 text-right text-sm font-semibold tabular-nums sm:block", qualityColor(p.quality_score))}>{p.quality_score ? `${p.quality_score}%` : "—"}</span>
                    <span className="w-28 text-right"><StatusBadge status={p.status} /></span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="ai-surface border-b border-ai-100 px-5 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-ai-900"><Sparkles className="size-4 text-ai-600" /> AI Insights</div>
                <AIBadge label="Live" />
              </div>
              <p className="mt-0.5 text-xs text-ai-800/70">Things worth your attention across all pipelines</p>
            </div>
            <div className="space-y-0.5 p-2">
              {loading && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="m-3 h-4" />)}
              {data?.insights.length === 0 && <div className="px-3 py-8 text-center text-sm text-slate-500">Everything looks healthy. ✨</div>}
              {data?.insights.slice(0, 5).map((a) => <InsightRow key={a.id} a={a} />)}
              {(data?.insights.length ?? 0) > 5 && <Link href="/monitoring" className="block px-3 py-2 text-sm font-semibold text-brand-600 hover:text-brand-700">See all {data?.insights.length} insights →</Link>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
