"use client";

import { ArrowDown, ArrowRight, KeyRound, RefreshCw, Sparkles, Layers } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Architecture } from "@/components/lakehouse/Architecture";
import { GovernancePanel } from "@/components/governance/GovernancePanel";
import { QualityPanel } from "@/components/quality/QualityPanel";
import { TargetsPanel } from "@/components/targets/TargetsPanel";
import { AIBadge, Badge, Button, Dialog, Field, Input, Switch } from "@/components/ui";
import { Cylinder } from "@/components/lakehouse/Cylinder";
import { FileTypeIcon } from "@/components/source/FileTypeIcon";
import { api } from "@/lib/api";
import type { LakehouseDesign, Pipeline, TableDesign } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { CheckItem, NextButton, PillTabs, SectionCard, WizardFooter } from "./common";

const LAYER_TONE = { bronze: "bronze", silver: "silver", gold: "gold" } as const;

function TableEditor({ table, onSave, advanced }: { table: TableDesign; onSave: (t: TableDesign) => void; advanced: boolean }) {
  const [t, setT] = useState(table);
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const dirty = JSON.stringify(t) !== JSON.stringify(table);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><Badge tone={LAYER_TONE[t.layer]}>{t.layer}</Badge>{t.business_entity && <Badge tone="brand">{t.business_entity}</Badge>}</div>
      <Field label="Table name"><Input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} disabled={!advanced} className="font-mono" /></Field>
      <div className="text-sm text-slate-600">{t.description}</div>
      {t.layer !== "bronze" && (
        <>
          <Field label="Primary key" hint="Uniquely identifies each record."><Input value={t.primary_key.join(", ")} onChange={(e) => setT({ ...t, primary_key: list(e.target.value) })} disabled={!advanced} className="font-mono text-xs" /></Field>
          <Field label="Liquid clustering" hint="Columns used to organize data for fast filtering — replaces manual partitioning."><Input value={t.cluster_by.join(", ")} onChange={(e) => setT({ ...t, cluster_by: list(e.target.value) })} disabled={!advanced} className="font-mono text-xs" /></Field>
          {advanced && <Field label="Partition by" help="Only for very large tables (100M+ rows)."><Input value={t.partition_by.join(", ")} onChange={(e) => setT({ ...t, partition_by: list(e.target.value) })} className="font-mono text-xs" /></Field>}
        </>
      )}
      {advanced && <Field label="Retention (days)"><Input type="number" value={t.retention_days ?? ""} onChange={(e) => setT({ ...t, retention_days: e.target.value ? Number(e.target.value) : null })} placeholder="Use default" /></Field>}
      {advanced && <Switch checked={t.enabled} onCheckedChange={(v) => setT({ ...t, enabled: v })} label="Create this table" />}
      {t.source_tables.length > 0 && <div className="text-xs text-slate-500">Built from: {t.source_tables.map((s) => <code key={s} className="mr-1 rounded bg-slate-100 px-1">{s}</code>)}</div>}
      {advanced && <Button variant="primary" disabled={!dirty} onClick={() => onSave(t)}>Save table</Button>}
      {!advanced && <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">Switch to Advanced Mode to rename tables or change keys, clustering and retention.</div>}
    </div>
  );
}

export function DesignStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const params = useSearchParams();
  const meta = pipeline.metadata;
  const lh = meta.lakehouse;
  const advanced = meta.mode === "advanced";
  const [tab, setTab] = useState<"lakehouse" | "governance" | "quality" | "targets">((params.get("tab") as "lakehouse") ?? "lakehouse");
  const [view, setView] = useState<"simple" | "advanced" | "custom">(advanced ? "advanced" : "simple");
  const [selected, setSelected] = useState<TableDesign | null>(null);
  const [dialogTable, setDialogTable] = useState<TableDesign | null>(null);
  const update = (patch: Partial<LakehouseDesign>, success?: string) => mutate("lakehouse", () => api.put<Pipeline>(`/api/pipelines/${pipeline.id}/lakehouse`, patch), { success });
  const setMode = async (v: "simple" | "advanced" | "custom") => {
    setView(v);
    const want = v === "simple" ? "simple" : "advanced";
    if (want !== meta.mode) await mutate("mode", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}`, { mode: want }));
  };
  const on = lh.tables.filter((t) => t.enabled);
  const byLayer = (l: TableDesign["layer"]) => on.filter((t) => t.layer === l);
  const ds = meta.source.datasets.filter((d) => d.selected);
  const nRules = meta.quality_rules.filter((r) => r.enabled).length;
  const nSteps = meta.transformations.filter((t) => t.enabled).length;
  const suggested = [
    `Create Bronze layer to store raw ${meta.source.category === "file" ? "files" : "data"} as ingested (${byLayer("bronze").length} tables)`,
    meta.ingestion.schema_evolution !== "none" ? "Enable schema evolution for future changes" : "Schema changes are blocked and alerted",
    `Apply data cleaning and standardization in Silver (${nSteps} transformations)`,
    `Create business-ready tables in Gold (${byLayer("gold").map((t) => t.name).join(", ") || "none"})`,
    on.some((t) => t.partition_by.length) ? "Partition very large tables by date" : "Use liquid clustering on keys and dates for fast queries",
    `Add data quality checks (${nRules} rules: nulls, duplicates, formats…)`,
    `Register in Unity Catalog (${lh.catalog}) for governance`,
  ];
  const tableRows = [...byLayer("gold"), ...byLayer("silver")];

  return (
    <div className="animate-fade-in">
      <PillTabs value={tab} onChange={setTab} className="mb-4" tabs={[{ value: "lakehouse", label: "Lakehouse" }, { value: "governance", label: "Governance" }, { value: "quality", label: `Data Quality (${meta.quality_rules.filter((r) => r.enabled).length})` },
        { value: "targets", label: `Targets (${1 + meta.targets.filter((t) => t.enabled).length})` }]} />
      {tab === "lakehouse" && (
        <SectionCard icon={<Layers />} title="Design Lakehouse" subtitle="Choose architecture and let AI optimize it" help="Bronze keeps raw data, Silver holds cleaned tables, Gold holds business-ready models."
          actions={<Button variant="secondary" size="sm" onClick={() => mutate("regen", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/lakehouse/regenerate`), { success: "Design regenerated" })} loading={busy === "regen"}><RefreshCw /> Regenerate with AI</Button>}>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-50 p-1">
            {([["simple", "Simple Mode (Recommended)"], ["advanced", "Advanced Mode"], ["custom", "Custom Design"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => setMode(v)} className={cn("rounded-lg py-2 text-[13px] font-medium transition-all", view === v ? "bg-brand-600 text-white shadow-[0_4px_12px_-6px_rgb(38_89_235)]" : "text-slate-600 hover:text-slate-900")}>{l}</button>
            ))}
          </div>

          {view === "simple" && (
            <div className="mt-5 grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
              <div className="space-y-1">
                {[
                  { key: "source", icon: <FileTypeIcon format={meta.source.category === "file" ? ds[0]?.format : "table"} size={34} />, title: "Source", sub: meta.source.category === "file" ? `${ds.length > 1 ? `${ds.length} datasets` : "File"} (${ds[0]?.name.split(" › ")[0] ?? ""})` : meta.source.name },
                  { key: "bronze", icon: <Cylinder layer="bronze" />, title: "Bronze", sub: `Raw data (as ingested) · ${byLayer("bronze").length} tables` },
                  { key: "silver", icon: <Cylinder layer="silver" />, title: "Silver", sub: `Cleaned & enriched (dedupe, standardize) · ${byLayer("silver").length} tables` },
                  { key: "gold", icon: <Cylinder layer="gold" />, title: "Gold", sub: `Business ready (analytics & reporting) · ${byLayer("gold").length} tables` },
                ].map((n, i) => (
                  <div key={n.key}>
                    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
                      <span className="flex w-12 justify-center">{n.icon}</span>
                      <div className="min-w-0">
                        <div className="text-[14px] font-semibold text-slate-900">{n.title}</div>
                        <div className="text-[12px] text-slate-500">{n.sub}</div>
                      </div>
                    </div>
                    {i < 3 && <div className="flex justify-center py-1"><ArrowDown className="size-5 text-slate-400" /></div>}
                  </div>
                ))}
              </div>
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-2.5 flex items-center gap-2 text-[14px] font-semibold text-brand-700"><Sparkles className="size-4" /> Suggested Configuration <AIBadge /></div>
                  <ul className="space-y-2">{suggested.map((x) => <CheckItem key={x}>{x}</CheckItem>)}</ul>
                </div>
                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-2 text-[14px] font-semibold text-slate-900">Table Design (Suggested)</div>
                  <div className="divide-y divide-slate-100">
                    {tableRows.slice(0, 5).map((t) => (
                      <div key={t.id} className="flex items-center gap-3 py-2.5">
                        <Cylinder layer={t.layer === "gold" ? "gold" : "silver"} size={28} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-semibold text-brand-700">{t.name} <span className="font-normal text-slate-400">({t.layer === "gold" ? "Gold" : "Silver"})</span></div>
                          <div className="truncate text-[12px] text-slate-500">{t.description}</div>
                        </div>
                        <button onClick={() => setDialogTable(t)} className="flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:underline">View <ArrowRight className="size-3.5" /></button>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setMode("custom")} className="mt-2 flex w-full items-center justify-center gap-1 text-[13px] font-medium text-brand-600 hover:underline">View All Suggested Tables <ArrowRight className="size-3.5" /></button>
                </div>
              </div>
            </div>
          )}

          {view === "advanced" && (
            <div className="mt-5 grid gap-5 xl:grid-cols-4">
              <div className="space-y-4 xl:col-span-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-slate-500">Click a table to edit keys, clustering, partitioning and retention.</div>
                  <div className="flex gap-1.5 text-xs"><Badge tone="bronze">{byLayer("bronze").length} Bronze</Badge><Badge tone="silver">{byLayer("silver").length} Silver</Badge><Badge tone="gold">{byLayer("gold").length} Gold</Badge></div>
                </div>
                <Architecture meta={meta} onSelect={setSelected} selected={selected?.id} />
                <div className="rounded-xl ai-surface p-4 ring-1 ring-ai-100">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ai-900"><Sparkles className="size-4 text-ai-600" /> Why this design <AIBadge /></div>
                  <ul className="mt-2 space-y-1 text-[13px] text-slate-700">{lh.rationale.map((r) => <li key={r}>• {r}</li>)}</ul>
                </div>
              </div>
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-3 text-sm font-semibold">Catalog & schemas</div>
                  <div className="space-y-3">
                    {(["catalog", "bronze_schema", "silver_schema", "gold_schema"] as const).map((k) => (
                      <Field key={k} label={k.replace("_", " ")}><Input defaultValue={lh[k]} onBlur={(e) => e.target.value !== lh[k] && update({ [k]: e.target.value } as Partial<LakehouseDesign>)} className="font-mono text-xs" /></Field>
                    ))}
                    <Field label="Default retention (days)"><Input type="number" defaultValue={lh.retention_days} onBlur={(e) => Number(e.target.value) !== lh.retention_days && update({ retention_days: Number(e.target.value) })} /></Field>
                  </div>
                </div>
                {selected && (
                  <div className="rounded-xl border border-slate-200 p-4 animate-slide-up">
                    <TableEditor key={selected.id} table={selected} advanced onSave={(t) => { void update({ tables: lh.tables.map((x) => (x.id === t.id ? t : x)) }, "Table updated"); setSelected(t); }} />
                  </div>
                )}
              </div>
            </div>
          )}

          {view === "custom" && (
            <div className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-200">
              {lh.tables.map((t) => (
                <div key={t.id} className={cn("flex items-center gap-3 px-4 py-2.5", !t.enabled && "opacity-50")}>
                  <Cylinder layer={t.layer} size={26} />
                  <code className="w-72 truncate text-[13px] text-slate-800">{t.name}</code>
                  <span className="flex-1 truncate text-[12.5px] text-slate-500">{t.description}</span>
                  {t.primary_key.length > 0 && <span className="flex items-center gap-1 text-xs text-amber-700"><KeyRound className="size-3" />{t.primary_key.join(", ")}</span>}
                  <Switch checked={t.enabled} onCheckedChange={(v) => update({ tables: lh.tables.map((x) => (x.id === t.id ? { ...x, enabled: v } : x)) })} />
                  <Button size="sm" variant="ghost" onClick={() => setDialogTable(t)}>Edit</Button>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}
      {tab === "governance" && <GovernancePanel pipeline={pipeline} mutate={mutate} />}
      {tab === "quality" && <QualityPanel pipeline={pipeline} mutate={mutate} />}
      {tab === "targets" && <TargetsPanel pipeline={pipeline} mutate={mutate} />}
      <Dialog open={!!dialogTable} onOpenChange={(v) => !v && setDialogTable(null)} title={dialogTable?.name ?? ""} description={dialogTable ? `${lh.catalog}.${dialogTable.layer === "gold" ? lh.gold_schema : dialogTable.layer === "silver" ? lh.silver_schema : lh.bronze_schema}.${dialogTable.name}` : ""} size="md">
        {dialogTable && <TableEditor key={dialogTable.id} table={dialogTable} advanced={advanced || view === "custom"} onSave={(t) => { void update({ tables: lh.tables.map((x) => (x.id === t.id ? t : x)) }, "Table updated"); setDialogTable(null); }} />}
      </Dialog>
      <WizardFooter onBack={() => goTo("configure")}
        primary={<NextButton onClick={async () => { await mutate("complete", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}`, { complete_step: "design" }), { silent: true }); goTo("review"); }}>Review & run readiness check</NextButton>} />
    </div>
  );
}
