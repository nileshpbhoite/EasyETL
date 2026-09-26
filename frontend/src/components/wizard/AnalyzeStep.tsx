"use client";

import { Brain, KeyRound, Link2, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { InsightList, RecommendationPanel } from "@/components/ai/Recommendations";
import { ProfileView } from "@/components/analyze/ProfileView";
import { AIBadge, Button, Card, CardHeader, ScoreRing, Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { api } from "@/lib/api";
import type { Pipeline } from "@/lib/types";
import { fmtNumber, timeAgo } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { NextButton, StepHeader, WizardFooter } from "./common";

const PHASES = ["Reading data from the source", "Detecting data types & formats", "Computing statistics & distributions", "Finding keys, duplicates & relationships", "Classifying personal data", "Generating best-practice recommendations"];

export function Analyzing() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPhase((p) => Math.min(p + 1, PHASES.length - 1)), 700);
    return () => clearInterval(t);
  }, []);
  return (
    <Card className="mx-auto max-w-xl overflow-hidden">
      <div className="gradient-ai flex flex-col items-center px-8 py-10 text-white">
        <div className="relative">
          <div className="absolute inset-0 animate-ping rounded-full bg-white/30" />
          <div className="relative flex size-16 items-center justify-center rounded-full bg-white/20 backdrop-blur">
            <Brain className="size-8" />
          </div>
        </div>
        <div className="mt-5 text-lg font-semibold">AI is analyzing your data</div>
        <div className="text-sm text-white/80">Deterministic profiling first, AI interpretation second.</div>
      </div>
      <div className="space-y-2.5 p-6">
        {PHASES.map((p, i) => (
          <div key={p} className="flex items-center gap-3 text-sm">
            <span className={i < phase ? "text-emerald-500" : i === phase ? "text-ai-600" : "text-slate-300"}>{i < phase ? "✓" : i === phase ? "●" : "○"}</span>
            <span className={i <= phase ? "text-slate-800" : "text-slate-400"}>{p}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AnalyzeStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const meta = pipeline.metadata;
  const selected = meta.source.datasets.filter((d) => d.selected);
  const needsAnalysis = !meta.analysis.profiled_at || selected.some((d) => !meta.analysis.profiles[d.id]);
  const started = useRef(false);
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
  const quality = profiles.length ? profiles.reduce((s, p) => s + p.quality.score, 0) / profiles.length : 0;
  const pii = profiles.reduce((s, p) => s + p.pii_columns.length, 0);
  const names = Object.fromEntries(meta.source.datasets.map((d) => [d.id, d.name.split(" › ").pop() ?? d.name]));
  const profile = meta.analysis.profiles[dsTab];
  const pk = profile?.primary_key_candidates[0];

  return (
    <div className="animate-fade-in">
      <StepHeader
        eyebrow="Step 2 · Analyze"
        title="Here's what AI found in your data"
        description="Facts come from deterministic profiling of your data; AI interprets them and recommends best practices."
        actions={<Button variant="secondary" onClick={analyze} loading={busy === "analyze"}><RefreshCw /> Re-analyze</Button>}
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Card className="flex items-center gap-4 p-4 xl:col-span-1">
          <ScoreRing score={quality} size={68} label="quality" />
          <div>
            <div className="text-xs font-medium text-slate-500">Data quality today</div>
            <div className="text-sm text-slate-700">Before any transformation</div>
          </div>
        </Card>
        <Card className="p-4"><div className="text-xs font-medium text-slate-500">Datasets · Records</div><div className="mt-1 text-2xl font-semibold">{selected.length} · {fmtNumber(rows)}</div><div className="text-xs text-slate-400">profiled {timeAgo(meta.analysis.profiled_at)} ({meta.analysis.strategy === "databricks" ? "Databricks" : "in-app"})</div></Card>
        <Card className="p-4"><div className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><KeyRound className="size-3.5 text-amber-500" /> Primary keys found</div><div className="mt-1 text-2xl font-semibold">{profiles.filter((p) => p.primary_key_candidates.length).length}/{profiles.length}</div><div className="text-xs text-slate-400">with confidence scores</div></Card>
        <Card className="p-4"><div className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><Link2 className="size-3.5 text-brand-500" /> Relationships</div><div className="mt-1 text-2xl font-semibold">{meta.analysis.relationships.length}</div><div className="text-xs text-slate-400">between datasets</div></Card>
        <Card className="p-4"><div className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><ShieldAlert className="size-3.5 text-rose-500" /> Sensitive columns</div><div className="mt-1 text-2xl font-semibold">{pii}</div><div className="text-xs text-slate-400">auto-classified as PII</div></Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <Card className="overflow-hidden">
            <div className="ai-surface border-b border-ai-100 px-5 py-3.5">
              <div className="flex items-center gap-2 font-semibold text-ai-900"><Sparkles className="size-4 text-ai-600" /> AI Insights <AIBadge label={`${meta.analysis.insights.length}`} /></div>
            </div>
            <div className="p-2"><InsightList insights={meta.analysis.insights} datasetNames={names} limit={8} /></div>
          </Card>
          <Card>
            <CardHeader title="Data profile" description="Click any column for distributions, formats and invalid examples." icon={<Brain />} />
            <div className="px-5 pt-2">
              <Tabs value={dsTab} onValueChange={setDsTab}>
                <TabsList>
                  {selected.map((d) => (
                    <TabsTrigger key={d.id} value={d.id}>{names[d.id]}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            <div className="p-5">
              {pk && (
                <div className="mb-4 rounded-lg ai-surface px-4 py-3 text-sm ring-1 ring-ai-100">
                  <span className="font-semibold text-ai-900">AI Insight: </span>
                  <span className="text-slate-700"><b>{pk.column}</b> appears to be the primary key with <b>{(pk.confidence * 100).toFixed(1)}%</b> confidence. {profile.primary_key_candidates.length > 1 && `Alternatives: ${profile.primary_key_candidates.slice(1).map((c) => c.column).join(", ")}.`} The dataset appears to represent <b>{meta.analysis.entities[dsTab] ?? "records"}</b> data.</span>
                </div>
              )}
              {profile && <ProfileView profile={profile} />}
            </div>
          </Card>
        </div>
        <div className="xl:col-span-2">
          <div className="sticky top-[150px]">
            <RecommendationPanel pipeline={pipeline} mutate={mutate} compact />
          </div>
        </div>
      </div>
      <WizardFooter onBack={() => goTo("source")} note={`${meta.transformations.length} transformation step${meta.transformations.length !== 1 ? "s" : ""} in your pipeline`} primary={<NextButton onClick={() => goTo("transform")}>Open Transformation Studio</NextButton>} />
    </div>
  );
}
