"use client";

import {
  ArrowRight, Cloud, Clock, Database, DollarSign, Ellipsis, FileSpreadsheet, FileUp, Gauge, Globe, LayoutTemplate, Library, MessageCircleQuestion, Plus,
  SearchCheck, Server, ShieldCheck, Sparkles, TrendingUp, TriangleAlert, Upload, Wand, Workflow, X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HeroArt, Robot } from "@/components/art";
import { KpiTile, Ring, type Trend } from "@/components/charts/Mini";
import { Cylinder } from "@/components/lakehouse/Cylinder";
import { FileTypeIcon } from "@/components/source/FileTypeIcon";
import { createPipelineFromFiles } from "@/components/source/upload";
import { Button, EmptyState, ErrorBox, Skeleton, StatusBadge } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import { useUI } from "@/lib/store";
import { STEPS, type Alert, type PipelineSummary } from "@/lib/types";
import { cn, fmtCompact, fmtMoney, timeAgo } from "@/lib/utils";

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
  trends?: Record<"active_pipelines" | "data_sources" | "records" | "quality" | "failures" | "cost", Trend>;
  recent_pipelines: PipelineSummary[];
  insights: Alert[];
}

const QUICK = [
  { href: "/sources", icon: Database, title: "Connect Data", desc: "Apps, databases, files, APIs & more", tile: "from-sky-400 to-brand-500" },
  { href: "#upload", icon: Upload, title: "Upload File", desc: "Excel, CSV, JSON, XML, Parquet…", tile: "from-brand-400 to-ai-600" },
  { href: "/pipelines/new", icon: Sparkles, title: "Create Pipeline", desc: "Guided, AI-powered wizard", tile: "from-ai-400 to-fuchsia-500" },
  { href: "/templates", icon: LayoutTemplate, title: "Use Template", desc: "Pre-built templates for common use cases", tile: "from-emerald-400 to-teal-500" },
  { href: "/catalog", icon: Library, title: "Explore Catalog", desc: "Discover tables, lineage and quality", tile: "from-amber-400 to-orange-500" },
];

const PROMPTS = [
  { icon: SearchCheck, text: "Analyze my latest data" },
  { icon: Wand, text: "Suggest transformations" },
  { icon: MessageCircleQuestion, text: "Why did this pipeline fail?" },
];

const CATEGORY_TILE: Record<string, { icon: typeof Database; cls: string }> = {
  file: { icon: FileSpreadsheet, cls: "from-emerald-400 to-teal-500" },
  application: { icon: Cloud, cls: "from-sky-400 to-brand-500" },
  api: { icon: Globe, cls: "from-rose-400 to-pink-500" },
  database: { icon: Server, cls: "from-ai-400 to-brand-600" },
};

const ENGINE: Record<string, string> = { auto_loader: "File ingestion", lakeflow_connect: "Incremental sync", rest_api: "REST API ingestion", jdbc: "Batch ingestion", batch: "Batch ingestion", streaming: "Streaming" };

function dayLabels() {
  const now = Date.now();
  return Array.from({ length: 7 }, (_, i) => new Date(now - (6 - i) * 86400000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
}

/** How each insight is presented and what its action button does. */
function insightStyle(a: Alert) {
  const monitor = a.pipeline_id ? `/monitoring?pipeline=${a.pipeline_id}` : "/monitoring";
  const pipe = (step: string) => (a.pipeline_id ? `/pipelines/${a.pipeline_id}?step=${step}` : "/pipelines");
  switch (a.kind) {
    case "schema": return { icon: TriangleAlert, cls: "bg-brand-50 text-brand-600 ring-brand-100", action: "Review", href: pipe("transform") };
    case "recommendations": return { icon: Sparkles, cls: "bg-ai-50 text-ai-600 ring-ai-100", action: "Review", href: pipe("analyze") };
    case "cost": return { icon: DollarSign, cls: "bg-rose-50 text-rose-500 ring-rose-100", action: "Review", href: monitor };
    case "freshness": return { icon: Clock, cls: "bg-amber-50 text-amber-600 ring-amber-100", action: "Investigate", href: monitor };
    case "performance": return { icon: Gauge, cls: "bg-amber-50 text-amber-600 ring-amber-100", action: "Investigate", href: monitor };
    case "volume":
      return a.severity === "info"
        ? { icon: TrendingUp, cls: "bg-emerald-50 text-emerald-600 ring-emerald-100", action: "View", href: monitor }
        : { icon: TriangleAlert, cls: "bg-amber-50 text-amber-600 ring-amber-100", action: "Investigate", href: monitor };
    case "quality": return { icon: ShieldCheck, cls: a.severity === "info" ? "bg-emerald-50 text-emerald-600 ring-emerald-100" : "bg-amber-50 text-amber-600 ring-amber-100", action: a.severity === "info" ? "View" : "Investigate", href: monitor };
    case "failure": return { icon: TriangleAlert, cls: a.severity === "critical" ? "bg-rose-50 text-rose-500 ring-rose-100" : "bg-amber-50 text-amber-600 ring-amber-100", action: "Investigate", href: monitor };
    default: return { icon: Sparkles, cls: "bg-brand-50 text-brand-600 ring-brand-100", action: "View", href: monitor };
  }
}

function RowMenu({ p }: { p: PipelineSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <Button variant="ghost" size="icon" aria-label={`Actions for ${p.name}`} onClick={() => setOpen((v) => !v)}><Ellipsis /></Button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="glass absolute right-0 top-10 z-40 w-44 rounded-xl p-1 text-sm animate-fade-in">
            <Link href={`/pipelines/${p.id}`} className="block rounded-lg px-3 py-2 text-slate-700 hover:bg-white">Open pipeline</Link>
            {p.deployment_status === "deployed" && <Link href={`/monitoring?pipeline=${p.id}`} className="block rounded-lg px-3 py-2 text-slate-700 hover:bg-white">View monitoring</Link>}
            <Link href={`/catalog`} className="block rounded-lg px-3 py-2 text-slate-700 hover:bg-white">Open in catalog</Link>
          </div>
        </>
      )}
    </div>
  );
}

function AssistantCard() {
  const { openAssistant } = useUI();
  const [hidden, setHidden] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    try { setHidden(localStorage.getItem("easyetl.home.assistant") === "hidden"); } catch { /* storage unavailable */ }
  }, []);
  if (hidden) return null;
  const ask = (question: string) => openAssistant({ pipelineId: undefined, page: "home", question });
  return (
    <section className="relative overflow-hidden rounded-[22px] border border-white/80 bg-gradient-to-br from-white/85 via-ai-50/80 to-brand-100/70 p-5 shadow-card backdrop-blur-xl">
      <button onClick={() => { setHidden(true); try { localStorage.setItem("easyetl.home.assistant", "hidden"); } catch { /* storage unavailable */ } }}
        className="absolute right-3 top-3 rounded-lg p-1 text-slate-400 hover:bg-white/70 hover:text-slate-600" aria-label="Hide AI Assistant card"><X className="size-4" /></button>
      <div className="flex items-center gap-3">
        <Robot size={76} />
        <div>
          <h2 className="text-[19px] font-bold text-slate-900">AI Assistant</h2>
          <p className="text-[13px] leading-snug text-slate-500">Your personal data engineering copilot</p>
        </div>
      </div>
      <div className="mt-4 flex flex-col items-start gap-2">
        {PROMPTS.map((p) => (
          <button key={p.text} onClick={() => ask(p.text)} className="flex items-center gap-2 rounded-full bg-white/85 px-3.5 py-1.5 text-[12.5px] font-medium text-slate-700 ring-1 ring-slate-200/70 transition-all hover:-translate-y-px hover:text-brand-700 hover:ring-brand-200">
            <p.icon className="size-3.5 text-brand-500" /> {p.text}
          </button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) { ask(q.trim()); setQ(""); } }} className="mt-4 flex items-center gap-2 rounded-2xl bg-white/90 py-1.5 pl-4 pr-1.5 ring-1 ring-slate-200/70">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything…" aria-label="Ask the AI Assistant" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400" />
        <button type="submit" aria-label="Send" className="gradient-primary flex size-9 items-center justify-center rounded-full text-white shadow-glow"><ArrowRight className="size-4" /></button>
      </form>
    </section>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { data, error, loading, reload } = useApi<Dashboard>("/api/dashboard");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const labels = dayLabels();

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
  const t = data?.trends;
  const insights = (data?.insights ?? []).filter((i) => i.kind !== "summary");

  return (
    <div
      className="relative min-h-full"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); void handleFiles(e.dataTransfer.files); }}
    >
      {(dragging || uploading) && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-brand-500/10 backdrop-blur-sm md:left-[256px]">
          <div className="glass rounded-3xl border-2 border-dashed border-brand-300 px-12 py-10 text-center">
            <FileUp className="mx-auto size-10 text-brand-600" />
            <div className="mt-3 text-lg font-semibold">{uploading ? "Uploading & detecting…" : "Drop anything here"}</div>
            <div className="text-sm text-slate-500">We'll create a pipeline and analyze it automatically</div>
          </div>
        </div>
      )}
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && handleFiles(e.target.files)} />

      <div className="mx-auto max-w-[1560px] space-y-6 px-5 pb-10 md:px-8">
        {/* Hero */}
        <section className="relative min-h-[250px] pt-4">
          <HeroArt className="absolute -top-16 right-0 hidden h-[330px] w-[620px] lg:block" />
          <div className="relative max-w-[620px]">
            <h1 className="text-[36px] font-bold leading-[1.1] text-slate-900 md:text-[46px]">
              Turn <span className="gradient-text italic">any</span> data into insights on Databricks.
            </h1>
            <p className="mt-4 text-[17px] text-slate-600">Connect • Analyze • Transform • Deploy — No code, ever.</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/pipelines/new"><Button variant="primary" size="lg" className="h-12 rounded-2xl px-6"><Plus /> Create Pipeline</Button></Link>
              <Button variant="secondary" size="lg" className="h-12 rounded-2xl px-6" onClick={() => fileInput.current?.click()}><Upload /> Upload a File</Button>
            </div>
          </div>
        </section>

        <ErrorBox error={error} onRetry={reload} />

        {/* KPIs */}
        <section className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6">
          {loading || !m
            ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="glass h-[112px] rounded-[18px] p-4"><Skeleton className="h-4 w-24" /><Skeleton className="mt-5 h-8 w-20" /></div>)
            : (
              <>
                <KpiTile icon={<Workflow />} iconClass="bg-ai-50 text-ai-600" label="Active Pipelines" value={m.active_pipelines} trend={t?.active_pipelines} tone="violet" labels={labels} />
                <KpiTile icon={<Database />} iconClass="bg-brand-50 text-brand-600" label="Data Sources" value={m.data_sources} trend={t?.data_sources} tone="blue" labels={labels} />
                <KpiTile icon={<Database />} iconClass="bg-fuchsia-50 text-fuchsia-600" label="Records (24h)" value={fmtCompact(m.records_24h)} trend={t?.records} tone="violet" labels={labels} format={(v) => `${fmtCompact(v)} records`} />
                <KpiTile icon={<ShieldCheck />} iconClass="bg-emerald-50 text-emerald-600" label="Data Quality Score" value={m.quality_score ? `${m.quality_score}%` : "—"} trend={t?.quality} tone="green" labels={labels} format={(v) => `${v.toFixed(1)}% avg`} />
                <KpiTile icon={<TriangleAlert />} iconClass="bg-rose-50 text-rose-500" label="Failed Runs (7d)" value={t ? t.failures.series.reduce((a, b) => a + b, 0) : m.failed_pipelines} trend={t?.failures} tone="red" labels={labels} format={(v) => `${v} failed run${v === 1 ? "" : "s"}`} />
                <KpiTile icon={<DollarSign />} iconClass="bg-sky-50 text-sky-600" label="Est. Databricks Cost" value={fmtMoney(m.estimated_monthly_cost, 0)} trend={t?.cost} tone="blue" labels={labels} format={(v) => fmtMoney(v, 2)} />
              </>
            )}
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-6">
            {/* Quick actions */}
            <section>
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <h2 className="text-[22px] font-bold text-slate-900">Quick Actions</h2>
                  <p className="text-[14px] text-slate-500">Start your data journey in seconds</p>
                </div>
                <Link href="/help" className="flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">Learn more <ArrowRight className="size-4" /></Link>
              </div>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
                {QUICK.map((q) => (
                  <button key={q.title} onClick={() => (q.href === "#upload" ? fileInput.current?.click() : router.push(q.href))}
                    className="glass lift group flex flex-col rounded-[20px] p-5 text-left">
                    <span className={cn("flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg", q.tile)}><q.icon className="size-6" /></span>
                    <span className="mt-5 text-[15px] font-bold text-slate-900">{q.title}</span>
                    <span className="mt-1 text-[12.5px] leading-snug text-slate-500">{q.desc}</span>
                    <ArrowRight className="mt-4 size-4 text-slate-700 transition-transform group-hover:translate-x-1 group-hover:text-brand-600" />
                  </button>
                ))}
              </div>
            </section>

            {/* Recent pipelines */}
            <section>
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <h2 className="text-[22px] font-bold text-slate-900">Recent Pipelines</h2>
                  <p className="text-[14px] text-slate-500">Your latest work across all environments</p>
                </div>
                <Link href="/pipelines" className="flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">View all <ArrowRight className="size-4" /></Link>
              </div>
              <div className="glass overflow-x-auto rounded-[20px]">
                {data && data.recent_pipelines.length === 0 ? (
                  <EmptyState icon={<Workflow />} title="No pipelines yet" description="Drop a file anywhere on this page or create your first pipeline." action={<Link href="/pipelines/new"><Button variant="primary"><Plus /> Create Pipeline</Button></Link>} />
                ) : (
                  <table className="w-full min-w-[760px] text-sm">
                    <thead>
                      <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        <th className="px-5 pb-2 pt-4">Pipeline</th>
                        <th className="px-3 pb-2 pt-4">Source → Target</th>
                        <th className="px-3 pb-2 pt-4">Status</th>
                        <th className="px-3 pb-2 pt-4">Last run</th>
                        <th className="px-3 pb-2 pt-4 text-right">Records</th>
                        <th className="px-3 pb-2 pt-4">Quality</th>
                        <th className="w-12 px-3 pb-2 pt-4"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading && !data && Array.from({ length: 4 }).map((_, i) => <tr key={i}><td colSpan={7} className="px-5 py-3"><Skeleton className="h-8" /></td></tr>)}
                      {(data?.recent_pipelines ?? []).slice(0, 6).map((p) => {
                        const tile = CATEGORY_TILE[p.source_category ?? "file"] ?? CATEGORY_TILE.file;
                        const stepIdx = Math.max(0, STEPS.findIndex((s) => s.id === p.current_step));
                        const deployed = p.deployment_status === "deployed";
                        const status = !deployed ? "draft" : p.last_run?.status === "failed" ? "failed" : p.status;
                        return (
                          <tr key={p.id} onClick={() => router.push(deployed ? `/monitoring?pipeline=${p.id}` : `/pipelines/${p.id}`)} className="cursor-pointer border-t border-slate-200/50 transition-colors hover:bg-white/60">
                            <td className="px-5 py-3">
                              <div className="flex items-center gap-3">
                                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm", tile.cls)}><tile.icon className="size-[18px]" /></span>
                                <div className="min-w-0">
                                  <div className="truncate font-semibold text-slate-900">{p.name}</div>
                                  <div className="truncate text-xs text-slate-500">{p.source_label} · {ENGINE[p.ingestion_engine ?? ""] ?? "Ingestion"}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-3">
                              <span className="flex items-center gap-1.5" title={`${p.source_label} → ${p.target_label}`}>
                                <FileTypeIcon format={p.source_format ?? (p.source_category === "api" ? "api" : p.source_category === "file" ? "txt" : "table")} size={20} />
                                <ArrowRight className="size-3 text-slate-300" />
                                <Cylinder layer="gold" size={22} />
                              </span>
                            </td>
                            <td className="px-3 py-3"><StatusBadge status={status} /></td>
                            <td className="px-3 py-3 text-slate-600">{deployed ? (p.last_run ? timeAgo(p.last_run.started_at) : "—") : <span className="text-brand-600">Step {stepIdx + 1} of {STEPS.length}</span>}</td>
                            <td className="px-3 py-3 text-right tabular-nums text-slate-700">{deployed ? fmtCompact(p.records_processed) : "—"}</td>
                            <td className="px-3 py-3">
                              <span className="flex items-center gap-2">
                                <Ring value={p.quality_score} size={22} stroke={3.5} />
                                <span className="font-semibold tabular-nums text-slate-700">{p.quality_score ? `${p.quality_score}%` : "—"}</span>
                              </span>
                            </td>
                            <td className="px-3 py-3"><RowMenu p={p} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <AssistantCard />
            <section className="glass rounded-[22px] p-5">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-900"><Sparkles className="size-5 text-ai-500" /> Insights & Recommendations</h2>
                <Link href="/monitoring" className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-slate-600 hover:text-slate-900">View all <ArrowRight className="size-3.5" /></Link>
              </div>
              <div className="mt-3 divide-y divide-slate-200/50">
                {loading && !data && Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="my-3 h-10" />)}
                {data && insights.length === 0 && <div className="py-8 text-center text-sm text-slate-500">Everything looks healthy. ✨</div>}
                {insights.slice(0, 5).map((a) => {
                  const st = insightStyle(a);
                  return (
                    <div key={a.id} className="flex items-start gap-3 py-3">
                      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full ring-1", st.cls)}><st.icon className="size-[18px]" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-[13px] font-semibold leading-snug text-slate-900">{a.title}</div>
                        <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-slate-500">{a.pipeline_name && <span className="font-medium text-slate-600">{a.pipeline_name} · </span>}{a.recommendation}</div>
                      </div>
                      <Link href={st.href} className="shrink-0 rounded-lg bg-brand-50 px-3 py-1.5 text-[12px] font-semibold text-brand-700 ring-1 ring-brand-100 hover:bg-brand-100">{st.action}</Link>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
