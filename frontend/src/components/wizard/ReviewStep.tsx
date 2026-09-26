"use client";

import { Brain, CircleCheck, CircleX, Database, DollarSign, Gauge, Info, Layers, Lock, Rocket, ShieldCheck, Sparkles, TriangleAlert, Wand, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AIBadge, Badge, Button, Card, Progress, ScoreRing } from "@/components/ui";
import { api } from "@/lib/api";
import { useApi, useTransformLibrary } from "@/lib/hooks";
import type { HealthCheck, Pipeline } from "@/lib/types";
import { cn, fmtMoney, fmtNumber, humanize, timeAgo } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { ENGINES } from "./ConfigureStep";
import { NextButton, StepHeader, WizardFooter } from "./common";

function Section({ icon, title, question, children, onEdit }: { icon: React.ReactNode; title: string; question: string; children: React.ReactNode; onEdit?: () => void }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600 [&_svg]:size-4">{icon}</div>
          <div>
            <div className="font-semibold text-slate-900">{title}</div>
            <div className="text-xs text-slate-500">{question}</div>
          </div>
        </div>
        {onEdit && <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>}
      </div>
      <div className="mt-3 text-sm text-slate-700">{children}</div>
    </Card>
  );
}

export function ReadinessCheck({ pipeline, mutate, busy }: Pick<StepProps, "pipeline" | "mutate" | "busy">) {
  const hc = pipeline.metadata.health_check;
  const [fixing, setFixing] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(hc.checks.length);
  const run = async () => {
    setRevealed(0);
    const res = await mutate("health", () => api.post<Pipeline & { health: HealthCheck }>(`/api/pipelines/${pipeline.id}/health-check`));
    const n = res?.health?.checks.length ?? 0;
    for (let i = 1; i <= n; i++) setTimeout(() => setRevealed(i), i * 140);
  };
  const auto = useRef(false);
  useEffect(() => {
    if (!hc.ran_at && !auto.current) {
      auto.current = true;
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fix = async (f: string) => {
    setFixing(f);
    await mutate("fix", () => api.post<Pipeline & { message: string }>(`/api/pipelines/${pipeline.id}/fix`, { fix: f }), { success: "Fixed automatically" });
    setFixing(null);
    setRevealed(99);
  };
  const running = busy === "health";
  const checks = hc.checks.slice(0, running ? 0 : revealed);
  return (
    <Card className="overflow-hidden">
      <div className="bg-navy-900 px-5 py-4 text-white">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl gradient-ai"><Brain className="size-5" /></div>
            <div>
              <div className="font-semibold">AI Pipeline Readiness Check</div>
              <div className="text-xs text-slate-400">{hc.ran_at ? `Last run ${timeAgo(hc.ran_at)}` : "Checking everything before deployment"}</div>
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={run} loading={running}>Re-run</Button>
        </div>
        {hc.ran_at && !running && (
          <div className="mt-4 flex items-center gap-4">
            <div className="text-3xl font-bold">{hc.score}<span className="text-base font-normal text-slate-400">/100</span></div>
            <div className="flex-1"><Progress value={hc.score} tone={hc.ready ? "green" : "amber"} className="h-2 bg-white/10" /></div>
            <Badge tone={hc.ready ? "green" : "amber"} className="px-2.5 py-1 text-xs">{hc.ready ? "✓ Deployment Ready" : "Needs attention"}</Badge>
          </div>
        )}
      </div>
      <div className="divide-y divide-slate-50">
        {running && Array.from({ length: 6 }).map((_, i) => <div key={i} className="px-5 py-3"><div className="skeleton h-4 w-2/3" /></div>)}
        {checks.map((c) => (
          <div key={c.id} className="flex items-start gap-3 px-5 py-3 animate-slide-up">
            {c.status === "pass" ? <CircleCheck className="mt-0.5 size-5 text-emerald-500" /> : c.status === "fail" ? <CircleX className="mt-0.5 size-5 text-rose-500" /> : c.status === "warn" ? <TriangleAlert className="mt-0.5 size-5 text-amber-500" /> : <Info className="mt-0.5 size-5 text-sky-500" />}
            <div className="min-w-0 flex-1">
              <div className={cn("text-sm font-semibold", c.status === "pass" ? "text-slate-900" : c.status === "fail" ? "text-rose-800" : "text-slate-900")}>{c.status === "pass" ? "✓ " : ""}{c.label}</div>
              <div className="text-sm text-slate-600">{c.message}</div>
              {c.details.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-slate-500">{c.details.slice(0, 5).map((d) => <li key={d}>• {d}</li>)}</ul>}
            </div>
            {c.fix && c.status !== "pass" && (
              <Button size="sm" variant="ai" onClick={() => fix(c.fix!)} loading={fixing === c.fix}><Wand /> Fix Automatically</Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function ReviewStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const meta = pipeline.metadata;
  const lib = useTransformLibrary();
  const { data: cost } = useApi<{ monthly_total_usd: number; compute_usd: number; storage_usd: number; dbus_per_month: number; runs_per_month: number; assumptions: string }>(`/api/pipelines/${pipeline.id}/cost`, [meta.ingestion.frequency, meta.ingestion.compute]);
  const ds = meta.source.datasets.filter((d) => d.selected);
  const rows = ds.reduce((s, d) => s + (d.row_count ?? 0), 0);
  const profiles = ds.map((d) => meta.analysis.profiles[d.id]).filter(Boolean);
  const qBefore = profiles.length ? profiles.reduce((s, p) => s + p.quality.score, 0) / profiles.length : null;
  const after = ds.map((d) => meta.analysis.quality_after[d.id]?.quality_score).filter((x): x is number => x !== undefined);
  const qAfter = after.length ? after.reduce((a, b) => a + b, 0) / after.length : null;
  const byCat: Record<string, number> = {};
  for (const t of meta.transformations.filter((x) => x.enabled)) {
    const cat = lib?.transforms.find((s) => s.id === t.type)?.category ?? "other";
    byCat[cat] = (byCat[cat] ?? 0) + 1;
  }
  const hc = meta.health_check;
  return (
    <div className="animate-fade-in">
      <StepHeader eyebrow="Step 6 · Review" title="Review before deploying" description="A complete summary of what will be built on Databricks, plus an AI readiness check." />
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="grid gap-4 md:grid-cols-2 xl:col-span-3">
          <Section icon={<Database />} title="Source" question="What is being connected?" onEdit={() => goTo("source")}>
            <b>{meta.source.name}</b> · {ds.length} dataset{ds.length !== 1 ? "s" : ""} · {fmtNumber(rows)} records
            <div className="mt-1 flex flex-wrap gap-1">{ds.map((d) => <Badge key={d.id}>{d.name.split(" › ").pop()}</Badge>)}</div>
          </Section>
          <Section icon={<Sparkles />} title="Analysis" question="What did AI discover?" onEdit={() => goTo("analyze")}>
            {meta.analysis.insights.length} insights · {meta.analysis.relationships.length} relationships · {profiles.reduce((s, p) => s + p.pii_columns.length, 0)} sensitive columns
            <div className="mt-1 text-xs text-slate-500">Primary keys: {profiles.map((p) => p.primary_key_candidates[0]?.column).filter(Boolean).join(", ") || "—"}</div>
          </Section>
          <Section icon={<Wand />} title="Transformations" question="What will happen to the data?" onEdit={() => goTo("transform")}>
            {meta.transformations.filter((t) => t.enabled).length} steps ({meta.transformations.filter((t) => t.origin === "ai" && t.enabled).length} from AI)
            <div className="mt-1 flex flex-wrap gap-1">{Object.entries(byCat).map(([c, n]) => <Badge key={c} tone="brand">{lib?.categories.find((x) => x.id === c)?.label ?? c}: {n}</Badge>)}</div>
          </Section>
          <Section icon={<Zap />} title="Ingestion" question="Which Databricks technology will be used?" onEdit={() => goTo("configure")}>
            <b>{ENGINES[meta.ingestion.engine]?.label}</b> · {meta.ingestion.mode} · {humanize(meta.ingestion.frequency)}
            {meta.ingestion.engine === meta.ingestion.recommended_engine && <AIBadge label="Recommended" className="ml-1" />}
          </Section>
          <Section icon={<Layers />} title="Lakehouse" question="Bronze / Silver / Gold design" onEdit={() => goTo("design")}>
            {(["bronze", "silver", "gold"] as const).map((l) => (
              <div key={l} className="flex gap-2 text-xs"><span className="w-12 font-semibold capitalize">{l}</span><span className="truncate font-mono text-slate-500">{meta.lakehouse.tables.filter((t) => t.layer === l && t.enabled).map((t) => t.name).join(", ")}</span></div>
            ))}
          </Section>
          <Section icon={<Lock />} title="Governance" question="Unity Catalog & security" onEdit={() => goTo("design")}>
            Unity Catalog {meta.governance.unity_catalog ? "on" : "off"} · {meta.governance.pii.length} PII columns · {meta.governance.access_policies.length} access policies · audit {meta.governance.audit ? "on" : "off"}
          </Section>
          <Section icon={<ShieldCheck />} title="Data Quality" question="Rules enabled" onEdit={() => goTo("design")}>
            {meta.quality_rules.filter((r) => r.enabled).length} rules · quality {qBefore ? `${qBefore.toFixed(0)}%` : "—"} → <b className="text-emerald-600">{qAfter ? `${qAfter.toFixed(0)}%` : "—"}</b>
          </Section>
          <Section icon={<Gauge />} title="Performance" question="AI recommendations">
            {meta.ingestion.compute === "serverless" ? "Serverless compute" : `${meta.ingestion.compute} cluster`} · liquid clustering on {meta.lakehouse.tables.filter((t) => t.cluster_by.length).length} tables · {meta.ingestion.mode === "incremental" ? "incremental processing" : "full refresh"}
          </Section>
          <Section icon={<DollarSign />} title="Cost" question="Estimated processing & storage">
            {cost ? (<><b className="text-lg">{fmtMoney(cost.monthly_total_usd)}</b> / month <div className="text-xs text-slate-500">compute {fmtMoney(cost.compute_usd)} ({cost.dbus_per_month} DBU) · storage {fmtMoney(cost.storage_usd)}</div></>) : "…"}
          </Section>
          <Card className="flex items-center gap-4 p-5">
            <ScoreRing score={qAfter} size={72} label="after" />
            <div className="text-sm text-slate-600">Projected data quality after transformations{qBefore ? <>, up from <b>{qBefore.toFixed(0)}%</b></> : ""}.</div>
          </Card>
        </div>
        <div className="xl:col-span-2">
          <div className="sticky top-[150px]"><ReadinessCheck pipeline={pipeline} mutate={mutate} busy={busy} /></div>
        </div>
      </div>
      <WizardFooter onBack={() => goTo("design")} note={hc.ran_at && !hc.ready ? "Resolve the failed checks to enable deployment." : undefined}
        primary={<NextButton variant="databricks" disabled={!hc.ready} onClick={() => goTo("deploy")}><Rocket /> Continue to deploy</NextButton>} />
    </div>
  );
}
