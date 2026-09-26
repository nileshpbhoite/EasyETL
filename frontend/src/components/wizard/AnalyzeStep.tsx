"use client";

import { ArrowRight, Brain, CircleCheck, KeyRound, Link2, RefreshCw, Sparkles, TriangleAlert, Wand } from "lucide-react";
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

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

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
  const fileIds = (meta.source.config.file_ids as string[] | undefined) ?? [];
  const pending = meta.recommendations.filter((r) => r.status === "pending" && r.area === "transformation").length;
  const quality = profiles.length ? profiles.reduce((s, p) => s + p.quality.score, 0) / profiles.length : 0;
  const noun = meta.source.category === "file" ? (selected.some((d) => d.kind === "sheet") ? "Sheets" : "Files") : meta.source.category === "database" ? "Tables" : "Objects";
  const topInsights = meta.analysis.insights.slice(0, 8);

  return (
    <div className="animate-fade-in space-y-5">
      <SectionCard n={2} title="AI Analysis & Data Profiling" subtitle="We automatically analyze your data and provide insights"
        help="Statistics are calculated from your data. AI interprets them — it never invents numbers."
        actions={<Button variant="secondary" size="sm" onClick={analyze} loading={busy === "analyze"}><RefreshCw /> Re-analyze</Button>}>
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50/80 to-white p-4">
          <FileTypeIcon format={meta.source.category === "file" ? selected[0]?.format : meta.source.category === "api" ? "api" : "table"} size={38} />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-slate-900">{meta.source.category === "file" ? (fileIds.length > 1 ? `${fileIds.length} files` : selected[0]?.name.split(" › ")[0]) : meta.source.name}</div>
            <div className="text-[13px] text-slate-500">Profiled {timeAgo(meta.analysis.profiled_at)} · {meta.analysis.strategy === "databricks" ? "large-scale profiling on Databricks" : "in-app profiling"}</div>
          </div>
          <dl className="grid grid-cols-3 gap-x-8 text-sm">
            <dt className="text-xs text-slate-500">{noun}</dt><dt className="text-xs text-slate-500">Quality today</dt><dt className="text-xs text-slate-500">Total rows</dt>
            <dd className="font-semibold">{selected.length}</dd><dd className="font-semibold">{quality.toFixed(0)}%</dd><dd className="font-semibold">{fmtNumber(rows)}</dd>
          </dl>
        </div>

        <LineTabs value={tab} onChange={setTab} className="mt-4" tabs={[
          { value: "overview", label: "Overview" }, { value: "profile", label: "Data Profile" }, { value: "quality", label: "Quality Analysis" },
          { value: "relationships", label: "Relationships" }, { value: "insights", label: `AI Insights (${meta.analysis.insights.length})` },
        ]} />

        {tab === "overview" && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="Rows"><div className="text-2xl font-semibold">{fmtNumber(rows)}</div></Tile>
              <Tile label="Columns"><div className="text-2xl font-semibold">{cols}</div></Tile>
              <Tile label="Data types">
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                  {typeBreakdown(profiles).map(([g, n]) => (
                    <div key={g} className="flex items-center gap-1.5"><span className={cn("size-2 rounded-full", TYPE_DOT[g])} /><span className="font-semibold tabular-nums">{n}</span><span className="text-slate-500">{g}</span></div>
                  ))}
                </div>
              </Tile>
              <Tile label={noun}><div className="text-2xl font-semibold">{selected.length} detected</div></Tile>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <div className="text-[14px] font-semibold">{noun} Found</div>
                  <Button size="sm" variant="ghost" onClick={() => setTab("profile")}>Preview profile</Button>
                </div>
                <div className="divide-y divide-slate-100">
                  {selected.map((d) => {
                    const p = meta.analysis.profiles[d.id];
                    return (
                      <button key={d.id} onClick={() => { setDsTab(d.id); setTab("profile"); }} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50">
                        <span className="flex size-[18px] items-center justify-center rounded bg-brand-600 text-white"><CircleCheck className="size-3" /></span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-semibold text-slate-900">{names[d.id]}</div>
                          <div className="text-xs text-slate-500">{fmtNumber(p?.row_count)} rows</div>
                        </div>
                        <span className="w-24 text-xs text-slate-500">{p?.column_count} columns</span>
                        <span className={cn("w-12 text-right text-xs font-semibold", (p?.quality.score ?? 0) >= 90 ? "text-emerald-600" : (p?.quality.score ?? 0) >= 75 ? "text-amber-600" : "text-rose-600")}>{p?.quality.score.toFixed(0)}%</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="rounded-xl border border-ai-100 ai-surface">
                <div className="flex items-center gap-2.5 px-4 pt-3.5">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-ai-500 to-brand-500 text-white"><Sparkles className="size-4" /></span>
                  <div><div className="text-[14px] font-semibold text-slate-900">AI Insights</div><div className="text-[11.5px] text-slate-500">Based on automatic analysis</div></div>
                </div>
                <ul className="space-y-2 px-4 py-3">
                  {topInsights.map((i) => (
                    <li key={i.id} className="flex gap-2.5 text-[13px] text-slate-700">
                      {i.severity === "warning" || i.severity === "critical" ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" /> : <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />}
                      <span>{i.title}</span>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-ai-100 px-4 py-2.5 text-center">
                  <button onClick={() => setTab("insights")} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:underline">View Detailed Insights <ArrowRight className="size-3.5" /></button>
                </div>
              </div>
            </div>
            {pending > 0 && (
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-brand-100 bg-gradient-to-r from-brand-50 to-white p-4">
                <span className="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-lg font-semibold text-white">{pending}</span>
                <div className="flex-1">
                  <div className="text-[14px] font-semibold text-slate-900">{pending} transformation recommendations are ready</div>
                  <div className="text-[13px] text-slate-500">Review, preview and apply them in the Transformation Studio.</div>
                </div>
                <Button variant="primary" onClick={() => goTo("transform")}><Wand /> Open Transformation Studio</Button>
              </div>
            )}
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
      <WizardFooter onBack={() => goTo("source")} note={`${meta.transformations.length} transformation steps in your pipeline`}
        primary={<NextButton onClick={() => goTo("transform")}>Continue to Transform</NextButton>} />
    </div>
  );
}

