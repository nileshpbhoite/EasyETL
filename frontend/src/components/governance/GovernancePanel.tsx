"use client";

import { Eye, FileClock, GitBranch, Lock, Plus, ShieldCheck, Tag, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { AIBadge, Badge, Button, Card, CardHeader, Input, Select, Switch } from "@/components/ui";
import { api } from "@/lib/api";
import type { AccessPolicy, GovernanceConfig, Pipeline } from "@/lib/types";
import { humanize } from "@/lib/utils";

const ACTIONS = [
  { value: "tag", label: "Tag only" }, { value: "mask", label: "Mask (•••4567)" }, { value: "hash", label: "Hash (irreversible)" },
  { value: "tokenize", label: "Tokenize" }, { value: "encrypt", label: "Encrypt" }, { value: "restrict", label: "Restrict (hide column)" }, { value: "none", label: "No protection" },
];
const SENSITIVITY: Record<string, "red" | "amber" | "slate"> = { government_id: "red", financial: "red", email: "amber", phone: "amber", date_of_birth: "amber" };

export function GovernancePanel({ pipeline, mutate }: { pipeline: Pipeline; mutate: (l: string, fn: () => Promise<Pipeline>, o?: { success?: string }) => Promise<unknown> }) {
  const meta = pipeline.metadata;
  const gov = meta.governance;
  const names = Object.fromEntries(meta.source.datasets.map((d) => [d.id, d.name.split(" › ").pop()]));
  const [newGroup, setNewGroup] = useState("");
  const [tagKey, setTagKey] = useState("");
  const [tagVal, setTagVal] = useState("");
  const update = (patch: Partial<GovernanceConfig>, success?: string) => mutate("governance", () => api.put<Pipeline>(`/api/pipelines/${pipeline.id}/governance`, patch), { success });
  const setPolicies = (p: AccessPolicy[]) => update({ access_policies: p });
  const scopes = [{ value: "all", label: "Entire catalog" }, { value: "bronze", label: "Bronze" }, { value: "silver", label: "Silver" }, { value: "gold", label: "Gold" }];

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        <Card>
          <CardHeader title="Sensitive data (PII)" description="Detected automatically from column names and content. Protection is enforced with Unity Catalog column masks." icon={<Lock />}
            actions={<AIBadge label={`${gov.pii.length} detected`} />} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-400"><th className="px-5 py-2 font-medium">Column</th><th className="px-3 py-2 font-medium">Dataset</th><th className="px-3 py-2 font-medium">Classification</th><th className="px-3 py-2 font-medium">Confidence</th><th className="px-5 py-2 font-medium">Protection</th></tr></thead>
              <tbody>
                {gov.pii.length === 0 && <tr><td colSpan={5} className="px-5 py-6 text-center text-slate-500">No personal data detected.</td></tr>}
                {gov.pii.map((p, i) => (
                  <tr key={`${p.dataset_id}-${p.column}`} className="border-b border-slate-50">
                    <td className="px-5 py-2 font-mono text-[13px]">{p.column}</td>
                    <td className="px-3 py-2 text-slate-600">{names[p.dataset_id]}</td>
                    <td className="px-3 py-2"><Badge tone={SENSITIVITY[p.category] ?? "slate"}>{humanize(p.category)}</Badge></td>
                    <td className="px-3 py-2 text-xs text-slate-500">{Math.round(p.confidence * 100)}%</td>
                    <td className="px-5 py-2">
                      <Select value={p.action} onChange={(v) => update({ pii: gov.pii.map((x, j) => (j === i ? { ...x, action: v as typeof x.action } : x)) })} options={ACTIONS} className="w-48" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">Members of <code className="rounded bg-slate-100 px-1">pii_readers</code> see unmasked values; everyone else sees protected values. Bronze stays restricted to data engineers.</div>
        </Card>
        <Card>
          <CardHeader title="Access policies" description="Who can read or change each layer (Unity Catalog grants)." icon={<Users />} />
          <div className="space-y-2 p-5">
            {gov.access_policies.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input value={p.group} onChange={(e) => setPolicies(gov.access_policies.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)))} className="w-48 font-mono text-xs" />
                <span className="text-sm text-slate-500">can</span>
                <Select className="w-40" value={p.privilege} onChange={(v) => setPolicies(gov.access_policies.map((x, j) => (j === i ? { ...x, privilege: v } : x)))}
                  options={[{ value: "SELECT", label: "Read" }, { value: "MODIFY", label: "Read & modify" }, { value: "ALL_PRIVILEGES", label: "Full control" }, { value: "USE_SCHEMA", label: "Browse" }]} />
                <span className="text-sm text-slate-500">on</span>
                <Select className="w-40" value={p.scope} onChange={(v) => setPolicies(gov.access_policies.map((x, j) => (j === i ? { ...x, scope: v } : x)))} options={scopes} />
                <Button variant="ghost" size="icon" onClick={() => setPolicies(gov.access_policies.filter((_, j) => j !== i))} aria-label="Remove policy"><Trash2 /></Button>
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <Input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="Group name, e.g. finance_analysts" className="w-72" />
              <Button variant="secondary" disabled={!newGroup} onClick={() => { void setPolicies([...gov.access_policies, { group: newGroup, privilege: "SELECT", scope: "gold" }]); setNewGroup(""); }}><Plus /> Add policy</Button>
            </div>
          </div>
        </Card>
      </div>
      <div className="space-y-6">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 font-semibold"><ShieldCheck className="size-4 text-emerald-600" /> Unity Catalog</div>
          <div className="space-y-4">
            <Switch checked={gov.unity_catalog} onCheckedChange={(v) => update({ unity_catalog: v })} label="Govern with Unity Catalog" description={`Catalog: ${meta.lakehouse.catalog}`} />
            <Switch checked={gov.column_masks} onCheckedChange={(v) => update({ column_masks: v })} label="Column masks for PII" description="Protect sensitive columns for non-authorized users" />
            <Switch checked={gov.audit} onCheckedChange={(v) => update({ audit: v })} label={<span className="flex items-center gap-1.5"><FileClock className="size-3.5" /> Audit logging</span>} description="Record every read and change" />
            <Switch checked={gov.lineage} onCheckedChange={(v) => update({ lineage: v })} label={<span className="flex items-center gap-1.5"><GitBranch className="size-3.5" /> Lineage</span>} description="Track data from source to dashboard" />
          </div>
        </Card>
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 font-semibold"><Tag className="size-4 text-brand-600" /> Tags & ownership</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(gov.tags).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs">
                <b className="font-medium text-slate-600">{k}</b>: {v}
                <button onClick={() => { const t = { ...gov.tags }; delete t[k]; void update({ tags: t }); }} className="text-slate-400 hover:text-rose-500" aria-label={`Remove ${k}`}>×</button>
              </span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Input value={tagKey} onChange={(e) => setTagKey(e.target.value)} placeholder="key" className="h-8 text-xs" />
            <Input value={tagVal} onChange={(e) => setTagVal(e.target.value)} placeholder="value" className="h-8 text-xs" />
            <Button size="sm" variant="secondary" disabled={!tagKey} onClick={() => { void update({ tags: { ...gov.tags, [tagKey]: tagVal } }); setTagKey(""); setTagVal(""); }}>Add</Button>
          </div>
          <div className="mt-4">
            <div className="mb-1 text-xs font-medium text-slate-600">Data owner (notified on failures)</div>
            <Input defaultValue={gov.data_owner ?? ""} onBlur={(e) => e.target.value !== (gov.data_owner ?? "") && update({ data_owner: e.target.value || null })} placeholder="owner@company.com" />
          </div>
        </Card>
        <Card className="p-5 text-sm text-slate-600">
          <div className="mb-1 flex items-center gap-2 font-semibold text-slate-900"><Eye className="size-4" /> What gets created</div>
          Catalog <code>{meta.lakehouse.catalog}</code> with <code>{meta.lakehouse.bronze_schema}</code>, <code>{meta.lakehouse.silver_schema}</code> and <code>{meta.lakehouse.gold_schema}</code> schemas, {gov.access_policies.length} grants, {Object.keys(gov.tags).length} tags and {gov.pii.filter((p) => !["tag", "none"].includes(p.action)).length} column masks.
        </Card>
      </div>
    </div>
  );
}
