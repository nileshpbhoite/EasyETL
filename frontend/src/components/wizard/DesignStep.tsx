"use client";

import { KeyRound, Layers, Lock, RefreshCw, ShieldCheck, Sparkles, Table2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Architecture } from "@/components/lakehouse/Architecture";
import { GovernancePanel } from "@/components/governance/GovernancePanel";
import { QualityPanel } from "@/components/quality/QualityPanel";
import { AIBadge, Badge, Button, Card, CardHeader, Field, Input, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { api } from "@/lib/api";
import type { LakehouseDesign, Pipeline, TableDesign } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { NextButton, StepHeader, WizardFooter } from "./common";

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
  const [tab, setTab] = useState(params.get("tab") ?? "lakehouse");
  const [selected, setSelected] = useState<TableDesign | null>(null);
  const update = (patch: Partial<LakehouseDesign>, success?: string) => mutate("lakehouse", () => api.put<Pipeline>(`/api/pipelines/${pipeline.id}/lakehouse`, patch), { success });
  const counts = { bronze: lh.tables.filter((t) => t.layer === "bronze" && t.enabled).length, silver: lh.tables.filter((t) => t.layer === "silver" && t.enabled).length, gold: lh.tables.filter((t) => t.layer === "gold" && t.enabled).length };

  return (
    <div className="animate-fade-in">
      <StepHeader eyebrow="Step 5 · Design" title="Your Lakehouse, designed by AI" description="A Bronze → Silver → Gold (medallion) architecture with governance and data quality built in."
        actions={<Button variant="aiSoft" onClick={() => mutate("regen", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/lakehouse/regenerate`), { success: "Design regenerated" })} loading={busy === "regen"}><RefreshCw /> Regenerate with AI</Button>} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5">
          <TabsTrigger value="lakehouse"><Layers /> Lakehouse</TabsTrigger>
          <TabsTrigger value="governance"><Lock /> Governance</TabsTrigger>
          <TabsTrigger value="quality"><ShieldCheck /> Data Quality</TabsTrigger>
        </TabsList>
        <TabsContent value="lakehouse">
          <div className="grid gap-6 xl:grid-cols-4">
            <div className="space-y-6 xl:col-span-3">
              <Card className="p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold"><Layers className="size-4 text-brand-600" /> Architecture <span className="text-sm font-normal text-slate-500">— click a table to see details</span></div>
                  <div className="flex gap-1.5 text-xs">
                    <Badge tone="bronze">{counts.bronze} Bronze</Badge><Badge tone="silver">{counts.silver} Silver</Badge><Badge tone="gold">{counts.gold} Gold</Badge>
                  </div>
                </div>
                <Architecture meta={meta} onSelect={setSelected} selected={selected?.id} />
              </Card>
              <Card className="overflow-hidden">
                <div className="ai-surface px-5 py-4">
                  <div className="flex items-center gap-2 font-semibold text-ai-900"><Sparkles className="size-4 text-ai-600" /> Why this design <AIBadge /></div>
                  <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
                    {lh.rationale.map((r) => <li key={r} className="flex gap-2"><span className="text-ai-500">•</span>{r}</li>)}
                    {lh.relationships.length > 0 && <li className="flex gap-2"><span className="text-ai-500">•</span>{lh.relationships.length} relationships detected and documented as foreign keys (e.g. {lh.relationships[0].from_table}.{lh.relationships[0].from_column} → {lh.relationships[0].to_table}).</li>}
                  </ul>
                </div>
              </Card>
              <Card>
                <CardHeader title="Tables" description={`${lh.catalog}.{bronze, silver, gold}`} icon={<Table2 />} />
                <div className="divide-y divide-slate-50">
                  {lh.tables.map((t) => (
                    <button key={t.id} onClick={() => setSelected(t)} className={cn("flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-slate-50", selected?.id === t.id && "bg-brand-50/50", !t.enabled && "opacity-50")}>
                      <Badge tone={LAYER_TONE[t.layer]} className="w-14 justify-center">{t.layer}</Badge>
                      <code className="w-72 truncate text-[13px] text-slate-800">{t.name}</code>
                      <span className="flex-1 truncate text-sm text-slate-500">{t.description}</span>
                      {t.primary_key.length > 0 && <span className="flex items-center gap-1 text-xs text-amber-700"><KeyRound className="size-3" />{t.primary_key.join(", ")}</span>}
                    </button>
                  ))}
                </div>
              </Card>
            </div>
            <div className="space-y-6">
              <Card className="p-5">
                <div className="mb-3 text-sm font-semibold">{advanced ? "Catalog & schemas" : "Where your tables live"}</div>
                {advanced ? (
                  <div className="space-y-3">
                    {(["catalog", "bronze_schema", "silver_schema", "gold_schema"] as const).map((k) => (
                      <Field key={k} label={k.replace("_", " ")}><Input defaultValue={lh[k]} onBlur={(e) => e.target.value !== lh[k] && update({ [k]: e.target.value } as Partial<LakehouseDesign>)} className="font-mono text-xs" /></Field>
                    ))}
                    <Field label="Default retention (days)"><Input type="number" defaultValue={lh.retention_days} onBlur={(e) => Number(e.target.value) !== lh.retention_days && update({ retention_days: Number(e.target.value) })} /></Field>
                  </div>
                ) : (
                  <div className="space-y-1.5 font-mono text-xs text-slate-600">
                    <div>{lh.catalog}.<span className="text-orange-700">{lh.bronze_schema}</span></div>
                    <div>{lh.catalog}.<span className="text-slate-800">{lh.silver_schema}</span></div>
                    <div>{lh.catalog}.<span className="text-amber-700">{lh.gold_schema}</span></div>
                  </div>
                )}
              </Card>
              {selected && (
                <Card className="p-5 animate-slide-up">
                  <TableEditor key={selected.id + String(advanced)} table={selected} advanced={advanced} onSave={(t) => { void update({ tables: lh.tables.map((x) => (x.id === t.id ? t : x)) }, "Table updated"); setSelected(t); }} />
                </Card>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="governance"><GovernancePanel pipeline={pipeline} mutate={mutate} /></TabsContent>
        <TabsContent value="quality"><QualityPanel pipeline={pipeline} mutate={mutate} /></TabsContent>
      </Tabs>
      <WizardFooter onBack={() => goTo("configure")}
        primary={<NextButton onClick={async () => { await mutate("complete", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}`, { complete_step: "design" }), { silent: true }); goTo("review"); }}>Review & run readiness check</NextButton>} />
    </div>
  );
}
