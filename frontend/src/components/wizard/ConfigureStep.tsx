"use client";

import { ArrowRight, Bot, Cable, CalendarClock, FileStack, Globe, HardDriveDownload, Radio, RefreshCw, ShieldAlert, Sparkles, Star, Workflow, Zap, Settings2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Callout, Card, CardHeader, Dialog, Field, Input, Segmented, Select, Switch } from "@/components/ui";
import { api } from "@/lib/api";
import type { IngestionConfig, Pipeline } from "@/lib/types";
import { cn, fmtMoney } from "@/lib/utils";
import { useApi } from "@/lib/hooks";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { CheckItem, NextButton, SectionCard, WizardFooter } from "./common";

export const ENGINES: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; plain: string; best: string }> = {
  auto_loader: { label: "Auto Loader", icon: FileStack, plain: "Watches a folder and loads only new files, automatically.", best: "Recurring files (CSV, JSON, XML, Excel exports)" },
  lakeflow_connect: { label: "Lakeflow Connect", icon: Cable, plain: "Databricks-managed connector that keeps a copy in sync, including changes.", best: "SaaS apps & databases with CDC" },
  batch: { label: "Batch", icon: HardDriveDownload, plain: "Loads everything on a schedule.", best: "Small or one-off loads" },
  streaming: { label: "Streaming", icon: Radio, plain: "Processes events continuously within seconds.", best: "Real-time events & IoT" },
  jdbc: { label: "JDBC", icon: RefreshCw, plain: "Reads tables directly from a database on a schedule.", best: "Databases without CDC" },
  rest_api: { label: "REST / API ingestion", icon: Globe, plain: "A scheduled job pages through an API and lands the results.", best: "Web APIs & SaaS without a managed connector" },
};

const SHORT: Record<string, string> = { auto_loader: "Recurring files", lakeflow_connect: "Apps & databases", batch: "One-time", streaming: "Near real-time", jdbc: "If data is in a database", rest_api: "Web APIs" };

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
  const why = [
    ...ing.rationale.split(/(?<=\.)\s+/).filter((x) => x.length > 12).slice(0, 2),
    ...ing.notes,
    ing.schema_evolution !== "none" ? "Schema evolution is enabled to handle future changes safely." : "",
    ing.mode === "incremental" ? "Incremental loading keeps runs fast and cost predictable." : "",
    "Lakeflow provides built-in monitoring, retries and error handling.",
  ].filter(Boolean).slice(0, 6);
  const incFields = Array.from(new Set(meta.source.datasets.filter((d) => d.selected).flatMap((d) => (d.columns ?? []).filter((c) => ["date", "timestamp"].includes(c.semantic_type ?? "")).map((c) => c.name))));

  return (
    <div className="animate-fade-in">
      <SectionCard icon={<Settings2 />} title="AI Recommendations" subtitle="Based on your data analysis, here are the best practices for getting data into Databricks" help="You don't need to know these technologies — EasyETL picks the right one, and you can change anything." className="mb-5">
        <div className="rounded-2xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Bot className="size-6" /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold text-brand-700">Recommended Configuration</div>
              <div className="text-[12.5px] text-slate-500">Based on your data type, volume and quality analysis</div>
            </div>
            {ing.engine === rec ? <span className="rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">Best Choice</span>
              : <Button size="sm" variant="primary" onClick={() => update({ engine: rec })}><Sparkles /> Use Recommendation</Button>}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              { icon: recSpec?.icon ?? FileStack, label: "Ingestion Method", value: current?.label ?? ing.engine, desc: `Best for ${current?.best.toLowerCase() ?? "this source"}` },
              { icon: RefreshCw, label: "Load Mode", value: ing.mode === "incremental" ? "Incremental" : "Full refresh", desc: ing.mode === "incremental" ? "Loads only new or changed data each run" : "Reloads everything on every run" },
              { icon: Workflow, label: "Processing", value: "Lakeflow Declarative Pipelines", desc: "For scalable, reliable processing with built-in quality checks" },
              meta.source.category === "file" || meta.source.category === "cloud_storage"
                ? { icon: HardDriveDownload, label: "File Handling", value: "Land files in a Unity Catalog volume", desc: "Auto Loader processes new files incrementally" }
                : { icon: CalendarClock, label: "Schedule", value: FREQ.find((f) => f.value === ing.frequency)?.label ?? ing.frequency, desc: ing.cdc ? "Changes captured with CDC" : "Tuned to how often the source changes" },
            ].map((t) => (
              <div key={t.label} className="flex gap-3 rounded-xl border border-slate-200 p-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><t.icon className="size-[18px]" /></span>
                <div className="min-w-0">
                  <div className="text-[11.5px] text-slate-500">{t.label}</div>
                  <div className="text-[14px] font-semibold text-slate-900">{t.value}</div>
                  <div className="text-[12px] text-slate-500">{t.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-5 border-t border-slate-100 pt-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div>
              <div className="mb-2 text-[14px] font-semibold text-slate-900">Why this recommendation?</div>
              <ul className="space-y-2">
                {why.map((w) => <CheckItem key={w}>{w}</CheckItem>)}
              </ul>
            </div>
            <div className="rounded-xl border border-slate-200 p-3.5">
              <div className="mb-2 text-[14px] font-semibold text-slate-900">Alternative Options</div>
              <div className="space-y-1.5">
                {Object.entries(ENGINES).filter(([id]) => id !== rec).map(([id, e]) => (
                  <label key={id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-[13px] text-slate-700 hover:bg-slate-50">
                    <input type="radio" name="engine" checked={ing.engine === id} onChange={() => update({ engine: id })} className="size-4 accent-brand-600" />
                    {e.label} <span className="text-xs text-slate-400">({SHORT[id]})</span>
                  </label>
                ))}
                {ing.engine !== rec && (
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-[13px] text-slate-700 hover:bg-slate-50">
                    <input type="radio" name="engine" checked={false} onChange={() => update({ engine: rec })} className="size-4 accent-brand-600" />
                    Back to {recSpec?.label} <Star className="size-3.5 fill-amber-400 text-amber-400" />
                  </label>
                )}
              </div>
              <button onClick={() => setChoosing(true)} className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:underline">Compare options <ArrowRight className="size-3.5" /></button>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" size="lg" onClick={async () => { await mutate("complete", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}`, { complete_step: "configure" }), { silent: true }); goTo("design"); }}>Continue <ArrowRight /></Button>
          </div>
        </div>
      </SectionCard>
      <Dialog open={choosing} onOpenChange={setChoosing} title="Compare ingestion methods" description="All run natively on Databricks. The recommended option is marked with a star." size="lg">
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries(ENGINES).map(([id, e]) => (
            <button key={id} onClick={() => { void update({ engine: id }); setChoosing(false); }} className={cn("rounded-xl border p-4 text-left transition-all hover:shadow-card", ing.engine === id ? "border-brand-500 bg-brand-50/50" : "border-slate-200")}>
              <div className="flex items-center gap-2"><e.icon className="size-4 text-brand-600" /><span className="font-semibold">{e.label}</span>{id === rec && <Star className="size-3.5 fill-amber-400 text-amber-400" />}{ing.engine === id && <Badge tone="brand">Selected</Badge>}</div>
              <div className="mt-1 text-xs text-slate-600">{e.plain}</div>
              <div className="mt-2 text-[11px] text-slate-400">Best for: {e.best}</div>
            </button>
          ))}
        </div>
      </Dialog>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
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
