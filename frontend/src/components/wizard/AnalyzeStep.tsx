"use client";

import { ArrowRight, Brain, ChevronRight, CircleCheck, Columns3, Eye, KeyRound, Layers, Link2, RefreshCw, Rows3, Sparkles, Table2, TriangleAlert, Wand } from "lucide-react";
import { Gem, MiniStack } from "@/components/art";
import { Ring, SparkBars } from "@/components/charts/Mini";
import { useEffect, useRef, useState } from "react";
import { InsightList } from "@/components/ai/Recommendations";
import { ProfileView } from "@/components/analyze/ProfileView";
import { FileTypeIcon } from "@/components/source/FileTypeIcon";
import { AIBadge, Badge, Button, Card, Progress, ScoreRing, Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { api } from "@/lib/api";
import type { Pipeline, Profile } from "@/lib/types";
import { cn, fmtNumber, humanize, timeAgo } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { LineTabs, NextButton, SectionCard, WizardFooter } from "./common";

const PHASES = ["Reading data from the source", "Detecting data types & formats", "Computing statistics & distributions", "Finding keys, duplicates & relationships", "Classifying personal data", "Generating best-practice recommendations"];

export function Analyzing() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPhase((p) => Math.min(p + 1, PHASES.length - 1)), 700);
    return () => clearInterval(t);
  }, []);
  return (
    <Card className="mx-auto max-w-xl overflow-hidden rounded-2xl">
      <div className="flex flex-col items-center bg-gradient-to-br from-brand-500 to-ai-600 px-8 py-10 text-white">
        <div className="relative">
          <div className="absolute inset-0 animate-ping rounded-full bg-white/30" />
          <div className="relative flex size-16 items-center justify-center rounded-full bg-white/20 backdrop-blur"><Brain className="size-8" /></div>
        </div>
        <div className="mt-5 text-lg font-semibold">AI is analyzing your data</div>
        <div className="text-sm text-white/80">Deterministic profiling first, AI interpretation second.</div>
      </div>
      <div className="space-y-2.5 p-6">
        {PHASES.map((p, i) => (
          <div key={p} className="flex items-center gap-3 text-sm">
            <span className={i < phase ? "text-emerald-500" : i === phase ? "text-brand-600" : "text-slate-300"}>{i < phase ? "✓" : i === phase ? "●" : "○"}</span>
            <span className={i <= phase ? "text-slate-800" : "text-slate-400"}>{p}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const TYPE_GROUP: Record<string, string> = {
  integer: "Integer", decimal: "Decimal", currency: "Decimal", percentage: "Decimal", date: "Date", date_of_birth: "Date", timestamp: "Date",
  boolean: "Boolean", nested: "Nested",
};
const TYPE_DOT: Record<string, string> = { String: "bg-emerald-500", Integer: "bg-slate-800", Date: "bg-brand-500", Decimal: "bg-amber-500", Boolean: "bg-ai-500", Nested: "bg-rose-400" };

function typeBreakdown(profiles: Profile[]) {
  const counts: Record<string, number> = {};
  for (const p of profiles) for (const c of p.columns) {
    const g = TYPE_GROUP[c.semantic_type] ?? "String";
    counts[g] = (counts[g] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function Tile({ label, icon, iconClass, children, className }: { label: string; icon?: React.ReactNode; iconClass?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("glass-inset rounded-2xl p-4", className)}>
      <div className="flex items-center gap-2 text-[13px] font-medium text-slate-600">
        {icon && <span className={cn("flex size-7 items-center justify-center rounded-lg [&_svg]:size-4", iconClass)}>{icon}</span>}
        {label}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

const DIMENSIONS = [
  { key: "completeness", label: "Completeness", dot: "bg-emerald-500" },
  { key: "validity", label: "Validity", dot: "bg-brand-500" },
  { key: "uniqueness", label: "Uniqueness", dot: "bg-ai-500" },
  { key: "consistency", label: "Consistency", dot: "bg-amber-400" },
] as const;
const ROW_TILES = ["from-ai-400 to-ai-600", "from-emerald-400 to-teal-500", "from-brand-400 to-brand-600", "from-sky-400 to-brand-500", "from-amber-400 to-orange-500", "from-rose-400 to-pink-500"];

type Tab = "overview" | "profile" | "quality" | "relationships" | "insights";

export function AnalyzeStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const meta = pipeline.metadata;
  const selected = meta.source.datasets.filter((d) => d.selected);
  const needsAnalysis = !meta.analysis.profiled_at || selected.some((d) => !meta.analysis.profiles[d.id]);
  const started = useRef(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [dsTab, setDsTab] = useState<string>(selected[0]?.id ?? "");

  const analyze = () => mutate("analyze", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/analyze`), { success: "Analysis complete" });
  useEffect(() => {
    if (needsAnalysis && !started.current && selected.length) {
      started.current = true;
      void analyze();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAnalysis]);
  useEffect(() => {
    if (!selected.some((d) => d.id === dsTab) && selected[0]) setDsTab(selected[0].id);
  }, [selected, dsTab]);

  if (busy === "analyze" || needsAnalysis) return <div className="py-10"><Analyzing /></div>;

  const profiles = selected.map((d) => meta.analysis.profiles[d.id]).filter(Boolean);
  const rows = profiles.reduce((s, p) => s + p.row_count, 0);
  const cols = profiles.reduce((s, p) => s + p.column_count, 0);
  const names = Object.fromEntries(meta.source.datasets.map((d) => [d.id, d.name.split(" › ").pop() ?? d.name]));
  const profile = meta.analysis.profiles[dsTab];
  const pk = profile?.primary_key_candidates[0];
  const pending = meta.recommendations.filter((r) => r.status === "pending" && r.area === "transformation").length;
  const quality = profiles.length ? profiles.reduce((s, p) => s + p.quality.score, 0) / profiles.length : 0;
  const noun = meta.source.category === "file" ? (selected.some((d) => d.kind === "sheet") ? "Sheets" : "Files") : meta.source.category === "database" ? "Tables" : "Objects";
  const topInsights = meta.analysis.insights.slice(0, 8);
  const sourceFiles = [...new Set(selected.map((d) => d.name.split(" › ")[0]))];
  const chips = meta.source.category === "file" && sourceFiles.length > 1 ? sourceFiles : selected.map((d) => names[d.id]);
  const avgDim = (k: (typeof DIMENSIONS)[number]["key"]) => (profiles.length ? profiles.reduce((acc, p) => acc + p.quality[k], 0) / profiles.length : 0);

  return (
    <div className="animate-fade-in space-y-5">
      <SectionCard icon={<Sparkles />} title="AI Analysis & Data Profiling" subtitle="Automatically analyzed your data and found key insights."
        help="Statistics are calculated from your data. AI interprets them — it never invents numbers."
        actions={<Button variant="primary" onClick={analyze} loading={busy === "analyze"}><RefreshCw /> Re-analyze</Button>}>
        <div className="glass-inset flex flex-wrap items-center gap-x-6 gap-y-4 rounded-2xl p-4">
          <FileTypeIcon format={meta.source.category === "file" ? selected[0]?.format : meta.source.category === "api" ? "api" : "table"} size={42} />
          <div className="min-w-0">
            <div className="text-[17px] font-bold text-slate-900">{meta.source.category === "file" ? (sourceFiles.length > 1 ? `${sourceFiles.length} files analyzed` : `${sourceFiles[0] ?? selected[0]?.name} analyzed`) : `${meta.source.name || "Source"} analyzed`}</div>
            <div className="text-[13px] text-slate-500">Profiled {timeAgo(meta.analysis.profiled_at)} · {meta.analysis.strategy === "databricks" ? "Large-scale profiling on Databricks" : "In-app profiling"}</div>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap gap-2">
            {chips.slice(0, 4).map((c) => (
              <span key={c} className="flex items-center gap-1.5 rounded-lg bg-white/90 px-2.5 py-1 text-[12px] font-medium text-slate-700 ring-1 ring-slate-200/70">
                <FileTypeIcon format={meta.source.category === "file" ? selected[0]?.format : "table"} size={13} /> {c}
              </span>
            ))}
            {chips.length > 4 && <span className="rounded-lg bg-white/70 px-2.5 py-1 text-[12px] text-slate-500">+{chips.length - 4} more</span>}
          </div>
          <dl className="flex items-center gap-8 border-slate-200/70 pl-2 xl:border-l xl:pl-8">
            <div><dt className="text-xs text-slate-500">{noun}</dt><dd className="mt-0.5 text-[17px] font-bold text-slate-900">{selected.length}</dd></div>
            <div><dt className="text-xs text-slate-500">Total rows</dt><dd className="mt-0.5 text-[17px] font-bold text-slate-900">{fmtNumber(rows)}</dd></div>
            <div className="flex items-center gap-3">
              <div><dt className="text-xs text-slate-500">Data quality</dt><dd className="mt-0.5 text-[17px] font-bold text-slate-900">{quality.toFixed(0)}%</dd></div>
              <Ring value={quality} size={44} stroke={6} />
            </div>
          </dl>
        </div>

        <LineTabs value={tab} onChange={setTab} className="mt-4" tabs={[
          { value: "overview", label: "Overview" }, { value: "profile", label: "Data Profile" }, { value: "quality", label: "Quality Analysis" },
          { value: "relationships", label: "Relationships" }, { value: "insights", label: `AI Insights (${meta.analysis.insights.length})` },
        ]} />

        {tab === "overview" && (
          <div className="mt-5 space-y-5">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-[1fr_1fr_1.1fr_0.85fr_1.5fr]">
              <Tile icon={<Rows3 />} iconClass="bg-amber-50 text-amber-600" label="Rows">
                <div className="flex items-end justify-between gap-2">
                  <div><div className="font-display text-[28px] font-bold leading-none text-slate-900">{fmtNumber(rows)}</div><div className="mt-1.5 text-xs text-slate-500">across {selected.length} {noun.toLowerCase()}</div></div>
                  {profiles.length > 1 && <SparkBars data={profiles.map((p) => p.row_count)} labels={selected.map((d) => names[d.id])} format={(v) => `${fmtNumber(v)} rows`} tone="green" width={64} height={40} />}
                </div>
              </Tile>
              <Tile icon={<Columns3 />} iconClass="bg-brand-50 text-brand-600" label="Columns">
                <div className="flex items-end justify-between gap-2">
                  <div><div className="font-display text-[28px] font-bold leading-none text-slate-900">{cols}</div><div className="mt-1.5 text-xs text-slate-500">{profiles.reduce((s, p) => s + p.columns.filter((c) => c.pii).length, 0)} contain personal data</div></div>
                  {profiles.length > 1 && <SparkBars data={profiles.map((p) => p.column_count)} labels={selected.map((d) => names[d.id])} format={(v) => `${v} columns`} tone="blue" width={64} height={40} />}
                </div>
              </Tile>
              <Tile label="Data Types">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
                  {typeBreakdown(profiles).map(([g, n]) => (
                    <div key={g} className="flex items-center gap-1.5"><span className={cn("size-2 rounded-full", TYPE_DOT[g])} /><span className="font-semibold tabular-nums text-slate-800">{n}</span><span className="text-slate-500">{g}</span></div>
                  ))}
                </div>
              </Tile>
              <Tile icon={<Layers />} iconClass="bg-ai-50 text-ai-600" label={`${noun} Detected`}>
                <div className="flex items-end justify-between">
                  <div className="font-display text-[28px] font-bold leading-none text-slate-900">{selected.length}</div>
                  <MiniStack className="-mb-2 -mr-1 h-[52px] w-[70px]" />
                </div>
              </Tile>
              <Tile label="Data Quality Score" className="col-span-2 lg:col-span-1">
                <div className="flex items-center gap-4">
                  <Ring value={quality} size={72} stroke={8} label={<span className="text-[15px] font-bold text-slate-900">{quality.toFixed(0)}%</span>} />
                  <ul className="min-w-0 flex-1 space-y-1 text-[12px]">
                    {DIMENSIONS.map((d) => (
                      <li key={d.key} className="flex items-center gap-1.5"><span className={cn("size-2 rounded-full", d.dot)} /><span className="flex-1 text-slate-500">{d.label}</span><span className="font-semibold tabular-nums text-slate-800">{avgDim(d.key).toFixed(0)}%</span></li>
                    ))}
                  </ul>
                </div>
              </Tile>
            </div>

            <div className="grid gap-5 xl:grid-cols-2">
              <div className="glass-inset overflow-hidden rounded-2xl">
                <div className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-2.5 text-[16px] font-bold text-slate-900"><span className="flex size-8 items-center justify-center rounded-xl bg-ai-50 text-ai-600"><Layers className="size-4" /></span>{noun} Found</div>
                  <Button size="sm" variant="secondary" onClick={() => setTab("profile")}><Eye /> Preview data</Button>
                </div>
                <table className="w-full text-sm">
                  <thead><tr className="border-y border-slate-200/60 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400"><th className="px-5 py-2">{noun.replace(/s$/, "")} name</th><th className="px-3 py-2 text-right">Rows</th><th className="px-3 py-2 text-right">Columns</th><th className="px-3 py-2">Data quality</th><th className="w-8" /></tr></thead>
                  <tbody>
                    {selected.map((d, i) => {
                      const p = meta.analysis.profiles[d.id];
                      const q = p?.quality.score ?? 0;
                      return (
                        <tr key={d.id} onClick={() => { setDsTab(d.id); setTab("profile"); }} className="cursor-pointer border-b border-slate-200/40 last:border-0 hover:bg-white/70">
                          <td className="px-5 py-3"><span className="flex items-center gap-3"><span className={cn("flex size-8 items-center justify-center rounded-lg bg-gradient-to-br text-white", ROW_TILES[i % ROW_TILES.length])}><Table2 className="size-4" /></span><span className="font-semibold text-slate-900">{names[d.id]}</span></span></td>
                          <td className="px-3 py-3 text-right tabular-nums text-slate-700">{fmtNumber(p?.row_count)}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-slate-700">{p?.column_count}</td>
                          <td className="px-3 py-3">
                            <span className="flex items-center gap-2.5">
                              <span className={cn("w-9 text-right text-[13px] font-bold tabular-nums", q >= 90 ? "text-emerald-600" : q >= 75 ? "text-amber-500" : "text-rose-500")}>{q.toFixed(0)}%</span>
                              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200/70"><span className={cn("block h-full rounded-full", q >= 90 ? "bg-emerald-500" : q >= 75 ? "bg-amber-400" : "bg-rose-500")} style={{ width: `${q}%` }} /></span>
                            </span>
                          </td>
                          <td className="pr-4"><ChevronRight className="size-4 text-slate-400" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="glass-inset rounded-2xl">
                <div className="flex items-center justify-between px-5 pt-4">
                  <div className="flex items-center gap-3">
                    <span className="icon-tile flex size-10 items-center justify-center rounded-xl text-white"><Sparkles className="size-5" /></span>
                    <div><div className="text-[16px] font-bold text-slate-900">AI Insights</div><div className="text-[12px] text-slate-500">Based on automatic analysis</div></div>
                  </div>
                  <button onClick={() => setTab("insights")} className="text-[13px] font-semibold text-brand-600 hover:text-brand-700">View All ({meta.analysis.insights.length})</button>
                </div>
                <ul className="space-y-2.5 px-5 py-4">
                  {topInsights.map((i) => (
                    <li key={i.id} className="flex gap-2.5 text-[13px] text-slate-700">
                      {i.severity === "warning" || i.severity === "critical" ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" /> : <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />}
                      <span>{i.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {tab === "profile" && (
          <div className="mt-4">
            <Tabs value={dsTab} onValueChange={setDsTab}>
              <TabsList className="mb-4 border-none">
                {selected.map((d) => <TabsTrigger key={d.id} value={d.id} className="rounded-lg border-b-0 data-[state=active]:bg-brand-50">{names[d.id]}</TabsTrigger>)}
              </TabsList>
            </Tabs>
            {pk && (
              <div className="mb-4 rounded-xl ai-surface px-4 py-3 text-sm ring-1 ring-ai-100">
                <span className="font-semibold text-ai-900">AI Insight: </span>
                <span className="text-slate-700"><b>{pk.column}</b> appears to be the primary key with <b>{(pk.confidence * 100).toFixed(1)}%</b> confidence. The dataset appears to represent <b>{meta.analysis.entities[dsTab] ?? "records"}</b> data.</span>
              </div>
            )}
            {profile && <ProfileView profile={profile} />}
          </div>
        )}

        {tab === "quality" && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {selected.map((d) => {
              const p = meta.analysis.profiles[d.id];
              if (!p) return null;
              const issues = p.columns.filter((c) => (c.invalid_count ?? 0) > 0 || c.null_pct > 1 || (c.case_variant_values ?? 0) > 0).slice(0, 6);
              return (
                <div key={d.id} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center gap-4">
                    <ScoreRing score={p.quality.score} size={64} label="score" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold">{names[d.id]}</div>
                      <div className="mt-2 space-y-1.5">
                        {(["completeness", "validity", "uniqueness", "consistency"] as const).map((k) => (
                          <div key={k} className="flex items-center gap-2 text-xs">
                            <span className="w-24 text-slate-500">{humanize(k)}</span>
                            <Progress value={p.quality[k]} tone={p.quality[k] >= 90 ? "green" : p.quality[k] >= 75 ? "amber" : "red"} className="flex-1" />
                            <span className="w-10 text-right tabular-nums">{p.quality[k].toFixed(0)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  {issues.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-[12.5px]">
                      {issues.map((c) => (
                        <li key={c.name} className="flex justify-between gap-2">
                          <code className="text-slate-700">{c.name}</code>
                          <span className="text-slate-500">
                            {[c.null_pct > 1 ? `${c.null_pct}% missing` : null, c.invalid_count ? `${c.invalid_count} invalid` : null, c.case_variant_values ? `${c.case_variant_values} variants` : null].filter(Boolean).join(" · ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === "relationships" && (
          <div className="mt-4 space-y-2">
            {meta.analysis.relationships.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">No relationships between the selected datasets. Select several related sheets or files to detect keys across them.</div>}
            {meta.analysis.relationships.map((r) => (
              <div key={r.label} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
                <Link2 className="size-4 text-brand-600" />
                <code className="text-[13px] text-slate-800">{names[r.from_dataset]}.{r.from_column}</code>
                <ArrowRight className="size-4 text-slate-300" />
                <code className="text-[13px] text-slate-800">{names[r.to_dataset]}.<span className="inline-flex items-center gap-1"><KeyRound className="size-3 text-amber-500" />{r.to_column}</span></code>
                <div className="ml-auto flex items-center gap-2">
                  <Badge tone="green">{r.match_pct}% match</Badge>
                  {r.orphan_rows > 0 && <Badge tone="amber">{fmtNumber(r.orphan_rows)} orphan rows</Badge>}
                  <AIBadge label={`${Math.round(r.confidence * 100)}%`} />
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "insights" && (
          <div className="mt-4 rounded-xl border border-ai-100 ai-surface p-2">
            <InsightList insights={meta.analysis.insights} datasetNames={names} />
          </div>
        )}
      </SectionCard>
      <WizardFooter onBack={() => goTo("source")}
        note={pending > 0 ? (
          <span className="flex items-center gap-3">
            <Gem size={40} />
            <span><span className="block text-[14.5px] font-bold text-slate-900">{pending} transformation recommendation{pending !== 1 ? "s are" : " is"} ready</span><span className="block text-[12.5px] text-slate-500">Review, preview and apply them in the Transformation Studio.</span></span>
          </span>
        ) : `${meta.transformations.length} transformation steps in your pipeline`}
        primary={<NextButton onClick={() => goTo("transform")}><Wand /> {pending > 0 ? "Open Transformation Studio" : "Continue to Transform"}</NextButton>} />
    </div>
  );
}

