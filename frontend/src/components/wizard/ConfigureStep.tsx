"use client";

import { Cable, CalendarClock, CircleCheck, FileStack, Globe, HardDriveDownload, Radio, RefreshCw, ShieldAlert, Sparkles, Star, Zap } from "lucide-react";
import { useState } from "react";
import { AIBadge, Badge, Button, Callout, Card, CardHeader, Field, Input, Segmented, Select, Switch } from "@/components/ui";
import { api } from "@/lib/api";
import type { IngestionConfig, Pipeline } from "@/lib/types";
import { cn, fmtMoney } from "@/lib/utils";
import { useApi } from "@/lib/hooks";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { NextButton, StepHeader, WizardFooter } from "./common";

export const ENGINES: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; plain: string; best: string }> = {
  auto_loader: { label: "Auto Loader", icon: FileStack, plain: "Watches a folder and loads only new files, automatically.", best: "Recurring files (CSV, JSON, XML, Excel exports)" },
  lakeflow_connect: { label: "Lakeflow Connect", icon: Cable, plain: "Databricks-managed connector that keeps a copy in sync, including changes.", best: "SaaS apps & databases with CDC" },
  batch: { label: "Batch", icon: HardDriveDownload, plain: "Loads everything on a schedule.", best: "Small or one-off loads" },
  streaming: { label: "Streaming", icon: Radio, plain: "Processes events continuously within seconds.", best: "Real-time events & IoT" },
  jdbc: { label: "JDBC", icon: RefreshCw, plain: "Reads tables directly from a database on a schedule.", best: "Databases without CDC" },
  rest_api: { label: "REST / API ingestion", icon: Globe, plain: "A scheduled job pages through an API and lands the results.", best: "Web APIs & SaaS without a managed connector" },
};

const FREQ = [
  { value: "continuous", label: "Continuous" }, { value: "every_15_min", label: "Every 15 minutes" }, { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "manual", label: "Manually" },
];

export function ConfigureStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const meta = pipeline.metadata;
  const ing = meta.ingestion;
  const advanced = meta.mode === "advanced";
  const [choosing, setChoosing] = useState(false);
  const { data: cost, reload: reloadCost } = useApi<{ monthly_total_usd: number; runs_per_month: number; est_minutes_per_run: number }>(`/api/pipelines/${pipeline.id}/cost`, [ing.frequency, ing.compute, ing.mode]);
  const update = async (patch: Partial<IngestionConfig>) => {
    await mutate("ingestion", () => api.put<Pipeline>(`/api/pipelines/${pipeline.id}/ingestion`, patch));
    void reloadCost();
  };
  const rec = ing.recommended_engine ?? ing.engine;
  const recSpec = ENGINES[rec];
  const current = ENGINES[ing.engine];
  const incFields = Array.from(new Set(meta.source.datasets.filter((d) => d.selected).flatMap((d) => (d.columns ?? []).filter((c) => ["date", "timestamp"].includes(c.semantic_type ?? "")).map((c) => c.name))));

  return (
    <div className="animate-fade-in">
      <StepHeader eyebrow="Step 4 · Configure" title="How should data get into Databricks?" description="AI analyzed your source and chose the right Databricks ingestion method. You don't need to know these technologies — but you can change anything." />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card className="overflow-hidden">
            <div className="ai-surface p-6">
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex size-14 items-center justify-center rounded-2xl gradient-ai text-white shadow-lg">{recSpec && <recSpec.icon className="size-7" />}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge tone="amber"><Star className="fill-amber-400 text-amber-400" /> Recommended</Badge>
                    <AIBadge />
                  </div>
                  <div className="mt-1.5 text-2xl font-semibold text-slate-900">{recSpec?.label}</div>
                  <p className="mt-1 text-sm text-slate-600">{ing.rationale}</p>
                  {ing.notes.length > 0 && (
                    <ul className="mt-3 space-y-1">
                      {ing.notes.map((n) => <li key={n} className="flex gap-2 text-sm text-slate-600"><CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" /> {n}</li>)}
                    </ul>
                  )}
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {ing.engine === rec ? (
                  <Badge tone="green" className="px-3 py-1 text-xs"><CircleCheck /> Using recommendation</Badge>
                ) : (
                  <Button variant="ai" onClick={() => update({ engine: rec })}><Sparkles /> Use Recommendation</Button>
                )}
                <Button variant="secondary" onClick={() => setChoosing((v) => !v)}>Choose Another Method</Button>
              </div>
            </div>
            {choosing && (
              <div className="grid gap-3 border-t border-ai-100 p-5 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(ENGINES).map(([id, e]) => (
                  <button key={id} onClick={() => { void update({ engine: id }); setChoosing(false); }} className={cn("rounded-xl border p-4 text-left transition-all hover:shadow-card", ing.engine === id ? "border-brand-500 bg-brand-50/50" : "border-slate-200")}>
                    <div className="flex items-center gap-2"><e.icon className="size-4 text-brand-600" /><span className="font-semibold">{e.label}</span>{id === rec && <Star className="size-3.5 fill-amber-400 text-amber-400" />}</div>
                    <div className="mt-1 text-xs text-slate-600">{e.plain}</div>
                    <div className="mt-2 text-[11px] text-slate-400">Best for: {e.best}</div>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Loading & schedule" description="Chosen by AI — adjust with simple controls." icon={<CalendarClock />} />
            <div className="grid gap-5 p-5 md:grid-cols-2">
              <Field label="What to load each run" hint="Incremental loads only new or changed records — faster and cheaper.">
                <Segmented value={ing.mode} onChange={(v) => update({ mode: v })} options={[{ value: "incremental", label: "Only new & changed" }, { value: "full", label: "Everything (full refresh)" }]} />
              </Field>
              <Field label="How often" help={cost ? `≈ ${cost.runs_per_month} runs/month · ~${cost.est_minutes_per_run} min each · est. ${fmtMoney(cost.monthly_total_usd)}/month` : undefined}>
                <div className="flex gap-2">
                  <Select className="flex-1" value={ing.frequency} onChange={(v) => update({ frequency: v })} options={FREQ} />
                  {ing.frequency === "daily" && <Input type="time" className="w-28" value={ing.schedule_time} onChange={(e) => update({ schedule_time: e.target.value })} />}
                </div>
              </Field>
              {ing.mode === "incremental" && !["auto_loader"].includes(ing.engine) && (
                <Field label="Change-tracking field" hint="The column that tells us a record is new or updated.">
                  <Select value={ing.incremental_field ?? ""} onChange={(v) => update({ incremental_field: v || null })} placeholder="Detect automatically" options={incFields.map((f) => ({ value: f, label: f }))} />
                </Field>
              )}
              {["lakeflow_connect", "jdbc"].includes(ing.engine) && (
                <Field label="Change Data Capture (CDC)"><Switch checked={ing.cdc} onCheckedChange={(v) => update({ cdc: v })} label="Capture inserts, updates & deletes" description="Keeps Databricks in sync with the source, including deletions." /></Field>
              )}
              <Field label="When the source adds columns" hint="Schema evolution">
                <Select value={ing.schema_evolution} onChange={(v) => update({ schema_evolution: v })} options={[
                  { value: "add_new_columns", label: "Add them automatically (recommended)" }, { value: "rescue", label: "Keep them in a rescue column" },
                  { value: "fail_on_change", label: "Stop and alert me" }, { value: "none", label: "Ignore new columns" }]} />
              </Field>
              <Field label="If a record can't be processed">
                <Select value={ing.on_error} onChange={(v) => update({ on_error: v })} options={[{ value: "quarantine", label: "Quarantine it and continue (recommended)" }, { value: "skip", label: "Skip it" }, { value: "fail", label: "Stop the run" }]} />
              </Field>
            </div>
          </Card>

          {advanced ? (
            <Card>
              <CardHeader title="Advanced settings" description="Compute, retries, file handling, checkpointing and partitioning." icon={<Zap />} />
              <div className="grid gap-5 p-5 md:grid-cols-2">
                <Field label="Compute">
                  <Select value={ing.compute} onChange={(v) => update({ compute: v })} options={[{ value: "serverless", label: "Serverless (recommended)" }, { value: "small", label: "Small cluster" }, { value: "medium", label: "Medium cluster" }, { value: "large", label: "Large cluster" }]} />
                </Field>
                <Field label="File handling">
                  <Select value={ing.file_handling} onChange={(v) => update({ file_handling: v })} options={[{ value: "process_new_only", label: "Process new files only" }, { value: "reprocess_all", label: "Reprocess all files" }, { value: "archive_after_load", label: "Archive after loading" }]} />
                </Field>
                <Field label="Retries on failure">
                  <div className="flex gap-2">
                    <Select className="flex-1" value={String(ing.retries)} onChange={(v) => update({ retries: Number(v) })} options={[0, 1, 2, 3, 5].map((n) => ({ value: String(n), label: `${n} retr${n === 1 ? "y" : "ies"}` }))} />
                    <Select className="flex-1" value={String(ing.retry_delay_minutes)} onChange={(v) => update({ retry_delay_minutes: Number(v) })} options={[1, 5, 15, 30].map((n) => ({ value: String(n), label: `${n} min apart` }))} />
                  </div>
                </Field>
                <Field label="Checkpointing"><Switch checked={ing.checkpointing} onCheckedChange={(v) => update({ checkpointing: v })} label="Resume exactly where the last run stopped" /></Field>
              </div>
            </Card>
          ) : (
            <Callout tone="info" icon={<ShieldAlert />} title="Simple Mode">
              Compute (serverless), retries (3), checkpointing and file handling are managed for you. Switch to Advanced Mode at the top of the page to change them.
            </Callout>
          )}
        </div>
        <div className="space-y-4">
          <Card className="p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</div>
            <dl className="mt-3 space-y-2.5 text-sm">
              {[
                ["Method", current?.label ?? ing.engine],
                ["Loading", ing.mode === "incremental" ? "Incremental" : "Full refresh"],
                ["Schedule", FREQ.find((f) => f.value === ing.frequency)?.label + (ing.frequency === "daily" ? ` at ${ing.schedule_time} UTC` : "")],
                ["Schema changes", ing.schema_evolution.replace(/_/g, " ")],
                ["Errors", ing.on_error],
                ["Compute", ing.compute],
                ["Retries", `${ing.retries} × every ${ing.retry_delay_minutes} min`],
                ["Checkpointing", ing.checkpointing ? "On" : "Off"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium capitalize text-slate-800">{v}</dd></div>
              ))}
            </dl>
          </Card>
          {cost && (
            <Card className="p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Estimated cost</div>
              <div className="mt-2 text-3xl font-semibold">{fmtMoney(cost.monthly_total_usd)}<span className="text-sm font-normal text-slate-500"> / month</span></div>
              <div className="mt-1 text-xs text-slate-500">Compute + storage at list prices.</div>
            </Card>
          )}
        </div>
      </div>
      <WizardFooter onBack={() => goTo("transform")} note={busy === "ingestion" ? "Saving…" : undefined}
        primary={<NextButton onClick={async () => { await mutate("complete", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}`, { complete_step: "configure" }), { silent: true }); goTo("design"); }}>Design the Lakehouse</NextButton>} />
    </div>
  );
}
