"use client";

import { ArrowRight, Brain, CalendarClock, CircleCheck, CircleX, Cpu, DollarSign, Info, Layers, LayoutTemplate, Lock, Rocket, ShieldCheck, TriangleAlert, Wand, Zap, ClipboardCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Architecture } from "@/components/lakehouse/Architecture";
import { FileTypeIcon } from "@/components/source/FileTypeIcon";
import { AIBadge, Badge, Button, Progress, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useApi, useTransformLibrary } from "@/lib/hooks";
import type { HealthCheck, Pipeline } from "@/lib/types";
import { cn, fmtMoney, fmtNumber, humanize, timeAgo } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { ENGINES } from "./ConfigureStep";
import { CheckItem, LineTabs, NextButton, SectionCard, WizardFooter } from "./common";
import { SaveTemplateDialog } from "./SaveTemplateDialog";

type Tab = "summary" | "flow" | "transformations" | "quality" | "governance" | "cost" | "readiness";

export function ReadinessCheck({ pipeline, mutate, busy, compact }: Pick<StepProps, "pipeline" | "mutate" | "busy"> & { compact?: boolean }) {
  const hc = pipeline.metadata.health_check;
  const [fixing, setFixing] = useState<string | null>(null);
  const run = () => mutate("health", () => api.post<Pipeline & { health: HealthCheck }>(`/api/pipelines/${pipeline.id}/health-check`));
  const fix = async (f: string) => {
    setFixing(f);
    await mutate("fix", () => api.post<Pipeline & { message: string }>(`/api/pipelines/${pipeline.id}/fix`, { fix: f }), { success: "Fixed automatically" });
    setFixing(null);
  };
  const running = busy === "health";
  const checks = compact ? [...hc.checks].sort((a, b) => ["fail", "warn", "info", "pass"].indexOf(a.status) - ["fail", "warn", "info", "pass"].indexOf(b.status)) : hc.checks;
  return (
    <div className="glass-inset overflow-hidden rounded-2xl">
      <div className="flex items-center gap-3 bg-gradient-to-r from-brand-50 via-ai-50 to-white px-4 py-3">
        <span className="icon-tile flex size-9 items-center justify-center rounded-xl text-white"><Brain className="size-[18px]" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-bold text-slate-900">AI Pipeline Readiness Check</div>
          <div className="text-[11.5px] text-slate-500">{hc.ran_at ? `Last run ${timeAgo(hc.ran_at)}` : "Checking everything before deployment"}</div>
        </div>
        {hc.ran_at && !running && <div className="font-display text-xl font-bold text-slate-900">{hc.score}<span className="text-xs font-normal text-slate-400">/100</span></div>}
        <Button size="sm" variant="secondary" onClick={run} loading={running}>{hc.ran_at ? "Re-run" : "Run"}</Button>
      </div>
      {hc.ran_at && !running && <Progress value={hc.score} tone={hc.ready ? "green" : "amber"} className="h-1 rounded-none" />}
      <div className={cn("divide-y divide-slate-50", compact && "max-h-[330px] overflow-y-auto scrollbar-thin")}>
        {running && <div className="flex items-center gap-2 px-4 py-6 text-sm text-slate-500"><Spinner /> Checking source, schema, transformations, quality, governance, security, cost…</div>}
        {!running && checks.map((c) => (
          <div key={c.id} className={cn("flex items-start gap-2.5 px-4", compact ? "py-2" : "py-3")}>
            {c.status === "pass" ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : c.status === "fail" ? <CircleX className="mt-0.5 size-4 shrink-0 text-rose-500" /> : c.status === "warn" ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" /> : <Info className="mt-0.5 size-4 shrink-0 text-sky-500" />}
            <div className="min-w-0 flex-1">
              <div className={cn("text-[13px] font-semibold", c.status === "fail" ? "text-rose-800" : "text-slate-900")}>{c.label}</div>
              {(!compact || c.status !== "pass") && <div className="text-[12.5px] text-slate-600">{c.message}</div>}
              {!compact && c.details.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-slate-500">{c.details.slice(0, 5).map((d) => <li key={d}>• {d}</li>)}</ul>}
            </div>
            {c.fix && c.status !== "pass" && <Button size="sm" variant="ai" onClick={() => fix(c.fix!)} loading={fixing === c.fix}><Wand /> Fix Automatically</Button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryRow({ icon, color, title, lines, onEdit }: { icon: React.ReactNode; color: string; title: string; lines: React.ReactNode[]; onEdit?: () => void }) {
  return (
    <div className="flex items-start gap-3.5 py-3">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", color)}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-slate-900">{title}</div>
        {lines.map((l, i) => <div key={i} className="text-[13px] text-slate-600">{l}</div>)}
      </div>
      {onEdit && <button onClick={onEdit} className="text-[13px] font-medium text-brand-600 hover:underline">Edit</button>}
    </div>
  );
}

export function ReviewStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const router = useRouter();
  const meta = pipeline.metadata;
  const lib = useTransformLibrary();
  const [tab, setTab] = useState<Tab>("summary");
  const [templateOpen, setTemplateOpen] = useState(false);
  const { data: cost } = useApi<{ monthly_total_usd: number; compute_usd: number; storage_usd: number; dbus_per_month: number; runs_per_month: number; est_minutes_per_run: number; storage_gb: number; assumptions: string }>(`/api/pipelines/${pipeline.id}/cost`, [meta.ingestion.frequency, meta.ingestion.compute]);
  const auto = useRef(false);
  useEffect(() => {
    if (!meta.health_check.ran_at && !auto.current) {
      auto.current = true;
      void mutate("health", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/health-check`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ds = meta.source.datasets.filter((d) => d.selected);
  const rows = ds.reduce((s, d) => s + (d.row_count ?? 0), 0);
  const profiles = ds.map((d) => meta.analysis.profiles[d.id]).filter(Boolean);
  const qBefore = profiles.length ? profiles.reduce((s, p) => s + p.quality.score, 0) / profiles.length : null;
  const after = ds.map((d) => meta.analysis.quality_after[d.id]?.quality_score).filter((x): x is number => x !== undefined);
  const qAfter = after.length ? after.reduce((a, b) => a + b, 0) / after.length : null;
  const hc = meta.health_check;
  const steps = meta.transformations.filter((t) => t.enabled);
  const lh = meta.lakehouse;
  const layer = (l: string) => lh.tables.filter((t) => t.layer === l && t.enabled);
  const practices = [
    meta.ingestion.mode === "incremental" && "Incremental loading enabled",
    meta.ingestion.schema_evolution !== "none" && "Schema evolution configured",
    meta.quality_rules.some((r) => r.enabled) && `Data quality checks added (${meta.quality_rules.filter((r) => r.enabled).length})`,
    steps.some((s) => s.origin === "ai") && `${steps.filter((s) => s.origin === "ai").length} AI-recommended transformations applied`,
    meta.ingestion.compute === "serverless" && "Optimized serverless compute",
    lh.tables.some((t) => t.cluster_by.length) && "Liquid clustering on keys and dates",
    meta.governance.unity_catalog && "Unity Catalog governance",
    meta.governance.column_masks && meta.governance.pii.length > 0 && `${meta.governance.pii.length} sensitive columns protected`,
    "Monitoring and alerting set up",
  ].filter(Boolean) as string[];
  const deploy = () => router.push(`/pipelines/${pipeline.id}?step=deploy&autostart=1`);

  return (
    <div className="animate-fade-in">
      <SectionCard icon={<ClipboardCheck />} title="Review & Deploy" subtitle="Review the configuration, insights and deploy to Databricks">
        <LineTabs value={tab} onChange={setTab} className="mb-4" tabs={[
          { value: "summary", label: "Summary" }, { value: "flow", label: "Data Flow" }, { value: "transformations", label: "Transformations" }, { value: "quality", label: "Data Quality" },
          { value: "governance", label: "Governance" }, { value: "cost", label: "Cost Estimate" }, { value: "readiness", label: hc.ran_at ? `Readiness (${hc.score})` : "Readiness" },
        ]} />
        {tab === "summary" && (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div>
              <div className="text-[15px] font-semibold text-slate-900">Pipeline Summary</div>
              <div className="divide-y divide-slate-100">
                <SummaryRow icon={<FileTypeIcon format={meta.source.category === "file" ? ds[0]?.format : "table"} size={22} />} color="bg-emerald-50" title="Source"
                  lines={[meta.source.category === "file" ? ds.map((d) => d.name.split(" › ").pop()).join(", ") : meta.source.name, `${ds.length} dataset${ds.length !== 1 ? "s" : ""}, ${fmtNumber(rows)} rows`]} onEdit={() => goTo("source")} />
                <SummaryRow icon={<Zap className="size-5 text-amber-600" />} color="bg-amber-50" title="Ingestion Method" lines={[`${ENGINES[meta.ingestion.engine]?.label} (${humanize(meta.ingestion.mode)})`]} onEdit={() => goTo("configure")} />
                <SummaryRow icon={<Wand className="size-5 text-brand-600" />} color="bg-brand-50" title="Transformations" lines={[`${steps.length} steps · ${steps.filter((s) => s.origin === "ai").length} recommended by AI`]} onEdit={() => goTo("transform")} />
                <SummaryRow icon={<Layers className="size-5 text-orange-600" />} color="bg-orange-50" title="Lakehouse Architecture" lines={[`Bronze → Silver → Gold (${layer("bronze").length} · ${layer("silver").length} · ${layer("gold").length} tables)`]} onEdit={() => goTo("design")} />
                <SummaryRow icon={<ShieldCheck className="size-5 text-emerald-600" />} color="bg-emerald-50" title="Data Quality" lines={[`${meta.quality_rules.filter((r) => r.enabled).length} checks enabled · quality ${qBefore ? `${qBefore.toFixed(0)}%` : "—"} → ${qAfter ? `${qAfter.toFixed(0)}%` : "—"}`]} onEdit={() => goTo("design")} />
                <SummaryRow icon={<Lock className="size-5 text-brand-600" />} color="bg-brand-50" title="Governance" lines={[<>Unity Catalog <span className="text-slate-400">(catalog: {lh.catalog})</span> · {meta.governance.pii.length} PII columns</>]} onEdit={() => goTo("design")} />
                <SummaryRow icon={<Cpu className="size-5 text-brand-600" />} color="bg-brand-50" title="Compute" lines={[meta.ingestion.compute === "serverless" ? "Serverless (Recommended)" : `${humanize(meta.ingestion.compute)} cluster`]} onEdit={() => goTo("configure")} />
                <SummaryRow icon={<CalendarClock className="size-5 text-slate-600" />} color="bg-slate-100" title="Schedule" lines={[humanize(meta.ingestion.frequency) + (meta.ingestion.frequency === "daily" ? ` at ${meta.ingestion.schedule_time} UTC` : "")]} onEdit={() => goTo("configure")} />
              </div>
            </div>
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-amber-100 text-amber-600"><DollarSign className="size-5" /></span>
                  <div>
                    <div className="text-[14px] font-semibold text-slate-900">Estimated Cost</div>
                    <div className="mt-0.5 text-xl font-semibold">~ {cost ? fmtMoney(cost.monthly_total_usd / 30) : "…"} <span className="text-sm font-normal text-slate-500">per day</span></div>
                    <div className="text-[12px] text-slate-500">Based on data volume and processing requirements</div>
                    <button onClick={() => setTab("cost")} className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:underline">View Details <ArrowRight className="size-3.5" /></button>
                  </div>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 p-4">
                <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-brand-700"><Brain className="size-4" /> AI Best Practices Applied <AIBadge /></div>
                <ul className="space-y-1.5">{practices.map((p) => <CheckItem key={p}>{p}</CheckItem>)}</ul>
              </div>
              <ReadinessCheck pipeline={pipeline} mutate={mutate} busy={busy} compact />
              <Button variant="primary" size="lg" className="h-12 w-full text-[15px]" disabled={!hc.ready} onClick={deploy}><Rocket /> Deploy to Databricks</Button>
              <Button variant="secondary" className="w-full border-brand-300 text-brand-700" onClick={() => setTemplateOpen(true)}><LayoutTemplate /> Save as Template</Button>
              {!hc.ready && hc.ran_at && <div className="text-center text-xs text-slate-500">Resolve the failed checks above to enable deployment.</div>}
            </div>
          </div>
        )}
        {tab === "flow" && <Architecture meta={meta} height={440} />}
        {tab === "transformations" && (
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {steps.length === 0 && <div className="p-6 text-center text-sm text-slate-500">No transformations.</div>}
            {steps.map((s, i) => {
              const sp = lib?.transforms.find((t) => t.id === s.type);
              return (
                <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <span className="w-5 text-right text-xs text-slate-400">{i + 1}</span>
                  <span className="flex-1 font-medium text-slate-800">{s.label || sp?.label}</span>
                  <span className="text-slate-500">{meta.source.datasets.find((d) => d.id === s.dataset_id)?.name.split(" › ").pop()}</span>
                  <Badge>{lib?.categories.find((c) => c.id === sp?.category)?.label}</Badge>
                  {s.origin === "ai" && <AIBadge />}
                </div>
              );
            })}
          </div>
        )}
        {tab === "quality" && (
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {meta.quality_rules.filter((r) => r.enabled).map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <ShieldCheck className="size-4 text-emerald-500" />
                <span className="flex-1 text-slate-800">{r.description}</span>
                <Badge>{humanize(r.dimension)}</Badge>
                <Badge tone={r.on_fail === "fail" ? "red" : r.on_fail === "warn" ? "amber" : "brand"}>{r.on_fail}</Badge>
              </div>
            ))}
          </div>
        )}
        {tab === "governance" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="mb-2 text-[14px] font-semibold">Sensitive columns</div>
              {meta.governance.pii.map((p) => <div key={p.dataset_id + p.column} className="flex justify-between py-1 text-[13px]"><code>{p.column}</code><span className="text-slate-500">{humanize(p.category)} → <b className="text-slate-700">{p.action}</b></span></div>)}
            </div>
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="mb-2 text-[14px] font-semibold">Access policies</div>
              {meta.governance.access_policies.map((p, i) => <div key={i} className="py-1 text-[13px]"><code>{p.group}</code> <span className="text-slate-500">can</span> {p.privilege.replace("_", " ").toLowerCase()} <span className="text-slate-500">on</span> {p.scope}</div>)}
              <div className="mt-2 text-xs text-slate-500">Audit {meta.governance.audit ? "on" : "off"} · lineage {meta.governance.lineage ? "on" : "off"} · column masks {meta.governance.column_masks ? "on" : "off"}</div>
            </div>
          </div>
        )}
        {tab === "cost" && cost && (
          <div className="grid gap-4 md:grid-cols-4">
            {[["Per month", fmtMoney(cost.monthly_total_usd)], ["Compute", `${fmtMoney(cost.compute_usd)} · ${cost.dbus_per_month} DBU`], ["Storage", `${fmtMoney(cost.storage_usd)} · ${cost.storage_gb} GB`], ["Runs", `${cost.runs_per_month}/month · ~${cost.est_minutes_per_run} min`]].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-slate-200 p-4"><div className="text-xs text-slate-500">{k}</div><div className="mt-1 text-lg font-semibold">{v}</div></div>
            ))}
            <div className="text-xs text-slate-500 md:col-span-4">{cost.assumptions}</div>
          </div>
        )}
        {tab === "readiness" && <ReadinessCheck pipeline={pipeline} mutate={mutate} busy={busy} />}
      </SectionCard>
      <WizardFooter onBack={() => goTo("design")} note={hc.ran_at && !hc.ready ? "Resolve the failed checks to enable deployment." : undefined}
        primary={<NextButton disabled={!hc.ready} onClick={deploy}><Rocket /> Deploy to Databricks</NextButton>} />
      <SaveTemplateDialog key={pipeline.name} id={pipeline.id} open={templateOpen} onOpenChange={setTemplateOpen} defaultName={`${pipeline.name} template`} />
    </div>
  );
}
