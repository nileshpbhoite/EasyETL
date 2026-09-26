"use client";

import { ArrowRight, ArrowUpFromLine, Plus, Save, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Cylinder } from "@/components/lakehouse/Cylinder";
import { ConnectionForm, type ConnectionPayload } from "@/components/source/ConnectionForm";
import { Badge, Button, Callout, Dialog, EmptyState, Field, Input, Select, Skeleton, Switch } from "@/components/ui";
import { ConnectorIcon, SectionCard } from "@/components/wizard/common";
import { api } from "@/lib/api";
import { showError, useApi, type usePipeline } from "@/lib/hooks";
import type { ConnectorSpec, Pipeline, SavedConnection, TargetConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

const MODE_LABEL: Record<TargetConfig["mode"], string> = { append: "Append new rows", overwrite: "Overwrite (full refresh)", merge: "Merge / upsert on keys" };
const STORAGE = new Set(["s3", "adls", "azure_blob", "gcs", "onelake"]);
const DEST_LABEL = (connector: string) =>
  STORAGE.has(connector) ? "Folder" : ["kafka", "confluent", "event_hubs"].includes(connector) ? "Topic (default: table name)" : connector === "salesforce" ? "Salesforce object" :
    connector === "rest_api" ? "—" : ["mongodb", "cosmosdb", "elasticsearch", "cassandra"].includes(connector) ? "Collection / container / index" : "Schema";

type Draft = Omit<TargetConfig, "id" | "name" | "connector"> & { id?: string; key: string };

export function TargetsPanel({ pipeline, mutate }: { pipeline: Pipeline; mutate: ReturnType<typeof usePipeline>["mutate"] }) {
  const meta = pipeline.metadata;
  const lh = meta.lakehouse;
  const { data: conns, reload: reloadConns } = useApi<SavedConnection[]>("/api/connections?usage=target");
  const { data: catalog } = useApi<{ categories: { id: string; label: string; connectors: ConnectorSpec[] }[] }>("/api/connectors");
  const specs = useMemo(() => (catalog?.categories ?? []).flatMap((c) => c.connectors), [catalog]);
  const targetSpecs = specs.filter((s) => s.roles.includes("target"));
  const tables = lh.tables.filter((t) => t.enabled && t.layer !== "bronze");
  const toDraft = (t: TargetConfig): Draft => ({ ...t, key: t.id });
  const [drafts, setDrafts] = useState<Draft[]>(() => meta.targets.map(toDraft));
  const [picking, setPicking] = useState(false);
  const [newSpec, setNewSpec] = useState<ConnectorSpec | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDrafts(meta.targets.map(toDraft)), [meta.targets]);
  const dirty = JSON.stringify(drafts.map(({ key: _k, ...d }) => d)) !== JSON.stringify(meta.targets.map(({ name: _n, connector: _c, ...t }) => t));

  const add = (c: SavedConnection) => {
    setDrafts((d) => [...d, { key: crypto.randomUUID(), connection_id: c.id, tables: [], mode: c.target_modes.includes("overwrite") ? "overwrite" : c.target_modes[0],
      merge_keys: [], destination: "", file_format: "parquet", include_flagged: true, enabled: true }]);
    setPicking(false);
  };
  const upd = (key: string, patch: Partial<Draft>) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const save = async () => {
    setSaving(true);
    await mutate("targets", () => api.put<Pipeline>(`/api/pipelines/${pipeline.id}/targets`, drafts.map(({ key: _k, ...d }) => d)), { success: "Targets saved" });
    setSaving(false);
  };
  const createConnection = async (p: ConnectionPayload) => {
    try {
      const res = await api.post<SavedConnection & { test: { ok: boolean; message: string } }>("/api/connections", p);
      if (!res.test.ok) toast.warning("Saved, but the connection test failed", { description: res.test.message });
      await reloadConns();
      setNewSpec(null);
      add(res);
    } catch (e) {
      showError(e);
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard icon={<ArrowUpFromLine />} title="Targets" subtitle="Where curated data goes after every run. Unity Catalog is always written; add more destinations to publish Silver or Gold tables to."
        actions={<>
          <Button variant="secondary" onClick={() => setPicking(true)}><Plus /> Add target</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}><Save /> Save targets</Button>
        </>}>
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-gradient-to-r from-rose-50/70 to-white p-4 ring-1 ring-rose-100">
          <span className="flex size-10 items-center justify-center rounded-xl bg-[#ff3621] text-white"><Cylinder layer="gold" size={24} /></span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900">Databricks Unity Catalog <Badge tone="green" className="ml-1">Always on</Badge></div>
            <div className="text-[13px] text-slate-500"><code>{lh.catalog}.{lh.bronze_schema}</code> → <code>{lh.silver_schema}</code> → <code>{lh.gold_schema}</code> · DQ tables in <code>{lh.catalog}.{meta.quality.dq_schema}</code></div>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {drafts.length === 0 && (
            <EmptyState icon={<ArrowUpFromLine />} title="No extra targets" className="py-8"
              description="Publish curated tables to a database, warehouse, another Databricks catalog, cloud storage, Kafka, MongoDB, a REST API or Salesforce."
              action={<Button variant="primary" onClick={() => setPicking(true)}><Plus /> Add target</Button>} />
          )}
          {drafts.map((d) => {
            const conn = (conns ?? []).find((c) => c.id === d.connection_id);
            const spec = specs.find((s) => s.id === conn?.connector);
            const modes = conn?.target_modes ?? [];
            return (
              <div key={d.key} className={cn("glass-inset rounded-2xl p-4", !d.enabled && "opacity-60")}>
                <div className="flex flex-wrap items-center gap-3">
                  {spec && <ConnectorIcon icon={spec.icon} color={spec.color} size="sm" className="size-9 rounded-xl" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-900">{conn?.name ?? "Connection removed"}</div>
                    <div className="text-xs text-slate-500">{spec?.name}{spec?.target_note ? ` · ${spec.target_note}` : ""}</div>
                  </div>
                  <Switch checked={d.enabled} onCheckedChange={(v) => upd(d.key, { enabled: v })} tone="green" />
                  <Button variant="ghost" size="icon" aria-label="Remove target" onClick={() => setDrafts((x) => x.filter((y) => y.key !== d.key))}><Trash2 /></Button>
                </div>
                {!conn && <Callout tone="warning" className="mt-3"><TriangleAlert className="mr-1 inline size-4" />This connection no longer exists or isn't a target anymore. Remove it or pick another.</Callout>}
                {conn && (
                  <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <Field label="Tables to publish" help="Nothing selected = every Gold table" className="md:col-span-2">
                      <div className="flex flex-wrap gap-1.5">
                        {tables.map((t) => {
                          const on = d.tables.includes(t.name);
                          return (
                            <button key={t.id} type="button" onClick={() => upd(d.key, { tables: on ? d.tables.filter((x) => x !== t.name) : [...d.tables, t.name] })}
                              className={cn("flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-all",
                                on ? "bg-brand-600 text-white ring-brand-600" : "bg-white/80 text-slate-600 ring-slate-200 hover:ring-brand-300")}>
                              <Cylinder layer={t.layer === "gold" ? "gold" : "silver"} size={14} /> {t.name}
                            </button>
                          );
                        })}
                      </div>
                    </Field>
                    <Field label="Write mode">
                      <Select value={d.mode} onChange={(v) => upd(d.key, { mode: v as TargetConfig["mode"] })} options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
                    </Field>
                    {d.mode === "merge" ? (
                      <Field label="Key column(s)" required help="Records with the same key are updated">
                        <Input value={d.merge_keys.join(", ")} onChange={(e) => upd(d.key, { merge_keys: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="customer_id" />
                      </Field>
                    ) : conn.connector !== "rest_api" ? (
                      <Field label={DEST_LABEL(conn.connector)}>
                        <Input value={d.destination} onChange={(e) => upd(d.key, { destination: e.target.value })} placeholder={STORAGE.has(conn.connector) ? "easyetl/curated" : conn.connector === "databricks" ? "analytics" : "dbo"} />
                      </Field>
                    ) : <div />}
                    {d.mode === "merge" && conn.connector !== "rest_api" && (
                      <Field label={DEST_LABEL(conn.connector)}>
                        <Input value={d.destination} onChange={(e) => upd(d.key, { destination: e.target.value })} placeholder={conn.connector === "salesforce" ? "Account" : "dbo"} />
                      </Field>
                    )}
                    {STORAGE.has(conn.connector) && (
                      <Field label="File format">
                        <Select value={d.file_format} onChange={(v) => upd(d.key, { file_format: v as TargetConfig["file_format"] })}
                          options={["parquet", "delta", "csv", "json"].map((f) => ({ value: f, label: f.toUpperCase() }))} />
                      </Field>
                    )}
                    <div className="md:col-span-2 xl:col-span-4">
                      <Switch checked={d.include_flagged} onCheckedChange={(v) => upd(d.key, { include_flagged: v })}
                        label="Also send records with DQ flags"
                        description={d.include_flagged ? "Flagged records are delivered with their _dq_issues / _dq_status columns so consumers can see them." : "Only records that passed every rule are delivered. Quarantined records never are."} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!conns && <Skeleton className="h-24" />}
        </div>
        {drafts.length > 0 && (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
            Runs: <b>Lakeflow pipeline</b> <ArrowRight className="size-3" /> <b>publish task</b> writes each target. Credentials go to the Databricks secret scope <code>easyetl</code>, never into files.
          </div>
        )}
      </SectionCard>

      <Dialog open={picking} onOpenChange={setPicking} title="Add a target" description="Pick a saved target connection, or connect a new one." size="lg">
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-semibold text-slate-800">Saved target connections</div>
            {(conns ?? []).length === 0 ? <div className="rounded-xl bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">None yet — connect one below.</div> : (
              <div className="grid gap-2 sm:grid-cols-2">
                {(conns ?? []).map((c) => {
                  const s = specs.find((x) => x.id === c.connector);
                  return (
                    <button key={c.id} onClick={() => add(c)} className="flex items-center gap-3 rounded-xl bg-white/80 p-3 text-left ring-1 ring-slate-200 hover:ring-brand-300">
                      {s && <ConnectorIcon icon={s.icon} color={s.color} size="sm" />}
                      <span className="min-w-0"><span className="block truncate text-sm font-semibold">{c.name}</span><span className="block text-xs text-slate-500">{c.connector_name}</span></span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold text-slate-800">Connect a new target</div>
            <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 scrollbar-thin">
              {targetSpecs.map((s) => (
                <button key={s.id} onClick={() => { setPicking(false); setNewSpec(s); }} className="flex items-center gap-2.5 rounded-xl bg-white/80 p-2.5 text-left ring-1 ring-slate-200 hover:ring-brand-300">
                  <ConnectorIcon icon={s.icon} color={s.color} size="sm" />
                  <span className="truncate text-[13px] font-medium">{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Dialog>
      <Dialog open={!!newSpec} onOpenChange={(v) => !v && setNewSpec(null)} title="New target connection" size="lg">
        {newSpec && <ConnectionForm spec={newSpec} onConnect={createConnection} connectLabel="Save & add target" defaultUsage="target" allowedUsages={newSpec.roles.includes("source") ? ["target", "both"] : ["target"]} />}
      </Dialog>
    </div>
  );
}
