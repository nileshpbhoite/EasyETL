"use client";

import { ArrowDownToLine, ArrowUpFromLine, CircleCheck, CircleX, KeyRound, Plug, Rocket, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { FlowArt } from "@/components/art";
import { ConnectionForm, type ConnectionPayload } from "@/components/source/ConnectionForm";
import { ConnectorIcon, LineTabs, PillTabs } from "@/components/wizard/common";
import { Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, Input, Select, Switch, Tooltip } from "@/components/ui";
import { api } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import type { ConnectorSpec, SavedConnection } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";

const USAGE_LABEL = { source: "Source", target: "Target", both: "Source & target" } as const;

function RoleChips({ roles, className }: { roles: ConnectorSpec["roles"]; className?: string }) {
  return (
    <span className={cn("flex gap-1", className)}>
      {roles.includes("source") && <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10.5px] font-semibold text-sky-700 ring-1 ring-sky-100"><ArrowDownToLine className="size-3" />Source</span>}
      {roles.includes("target") && <span className="inline-flex items-center gap-1 rounded-full bg-ai-50 px-2 py-0.5 text-[10.5px] font-semibold text-ai-700 ring-1 ring-ai-100"><ArrowUpFromLine className="size-3" />Target</span>}
    </span>
  );
}

export default function SourcesPage() {
  const { data: catalog } = useApi<{ categories: { id: string; label: string; connectors: ConnectorSpec[] }[] }>("/api/connectors");
  const { data: conns, reload } = useApi<SavedConnection[]>("/api/connections");
  const [tab, setTab] = useState("all");
  const [role, setRole] = useState<"all" | "source" | "target">("all");
  const [connFilter, setConnFilter] = useState<"all" | "source" | "target">("all");
  const [q, setQ] = useState("");
  const [spec, setSpec] = useState<ConnectorSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState<SavedConnection | null>(null);
  const specs = (catalog?.categories ?? []).flatMap((c) => c.connectors);
  const shown = (catalog?.categories ?? [])
    .filter((c) => tab === "all" || c.id === tab)
    .flatMap((c) => c.connectors)
    .filter((c) => c.id !== "file_upload" && (role === "all" || c.roles.includes(role)) && (c.name + c.description).toLowerCase().includes(q.toLowerCase()));
  const listed = (conns ?? []).filter((c) => connFilter === "all" || c.usage === connFilter || c.usage === "both");
  const deployConn = (conns ?? []).find((c) => c.connector === "databricks" && c.config?.use_for_deployment);
  const counts = { total: specs.filter((c) => c.id !== "file_upload").length, targets: specs.filter((c) => c.roles.includes("target")).length };

  const save = async (p: ConnectionPayload) => {
    setSaving(true);
    try {
      const res = await api.post<{ status: string; test: { ok: boolean; message: string; title: string } }>("/api/connections", p);
      if (res.test.ok) toast.success(res.test.title === "Credentials saved" ? "Credentials saved" : "Connection saved", { description: "Credentials were encrypted in the secret store." });
      else toast.warning("Saved, but the connection test failed", { description: res.test.message });
      setSpec(null);
      void reload();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  };
  const patch = async (c: SavedConnection, body: Record<string, unknown>, msg: string) => {
    try {
      await api.patch(`/api/connections/${c.id}`, body);
      toast.success(msg);
      void reload();
    } catch (e) {
      showError(e);
    }
  };

  return (
    <div className="relative mx-auto max-w-[1400px] px-6 pb-10 pt-2 md:px-8">
      <FlowArt className="pointer-events-none absolute -top-4 right-8 hidden h-[130px] w-[260px] xl:block" />
      <h1 className="text-[32px] font-bold leading-tight text-slate-900">Sources & Targets</h1>
      <p className="mt-1.5 max-w-3xl text-[15px] text-slate-600">
        Connect once, reuse in any pipeline — as a source to read from, a target to publish curated data to, or both. {counts.total} connectors, {counts.targets} of them can also be targets.
      </p>

      {!deployConn && conns && (
        <div className="relative mt-6 flex flex-wrap items-center gap-4 rounded-[20px] bg-gradient-to-r from-rose-50 via-white to-brand-50 p-4 ring-1 ring-rose-100">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-[#ff3621] text-white shadow-md"><Rocket className="size-5" /></span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900">Connect your Databricks workspace</div>
            <div className="text-[13px] text-slate-600">Personal access token, OAuth service principal, Entra ID, managed identity, Azure CLI, GCP service account or a CLI profile. Until then deployments run in safe simulation mode.</div>
          </div>
          <Button variant="primary" onClick={() => setSpec(specs.find((s) => s.id === "databricks") ?? null)}>Connect Databricks</Button>
        </div>
      )}

      <Card className="relative mt-6">
        <CardHeader title="Saved connections" description="Credentials are encrypted at rest and never shown again." icon={<KeyRound />}
          actions={<PillTabs value={connFilter} onChange={setConnFilter} tabs={[{ value: "all", label: "All" }, { value: "source", label: "Sources" }, { value: "target", label: "Targets" }]} />} />
        {!listed.length ? <EmptyState icon={<Plug />} title={conns?.length ? "Nothing here" : "No saved connections"} description="Pick a connector below to add one." className="py-8" /> : (
          <div className="divide-y divide-slate-200/50">
            {listed.map((c) => {
              const s = specs.find((x) => x.id === c.connector);
              const options = (["source", "target", "both"] as const).filter((u) => (u === "source" ? c.roles.includes("source") : u === "target" ? c.roles.includes("target") : c.roles.length === 2));
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  {s && <ConnectorIcon icon={s.icon} color={s.color} size="sm" className="size-9 rounded-xl" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">{c.name}
                      {c.connector === "databricks" && c.config?.use_for_deployment && <Badge tone="brand"><Rocket /> Deployment workspace</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">{c.connector_name} · added {timeAgo(c.created_at)} {c.has_secrets && "· 🔒 credentials encrypted"}</div>
                  </div>
                  {c.connector === "databricks" && (
                    <Tooltip content="Deploy EasyETL pipelines to this workspace">
                      <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                        Deploy here <Switch checked={!!c.config?.use_for_deployment} onCheckedChange={(v) => patch(c, { use_for_deployment: v }, v ? "Deployments will go to this workspace" : "Back to simulation mode")} />
                      </label>
                    </Tooltip>
                  )}
                  {options.length > 1 ? (
                    <Select className="w-44" value={c.usage} onChange={(v) => patch(c, { usage: v }, `Now used as ${USAGE_LABEL[v as keyof typeof USAGE_LABEL].toLowerCase()}`)}
                      options={options.map((u) => ({ value: u, label: `Use as: ${USAGE_LABEL[u]}` }))} />
                  ) : (
                    <Badge tone={c.usage === "target" ? "ai" : "sky"}>{USAGE_LABEL[c.usage]}</Badge>
                  )}
                  {c.status === "connected" ? <Badge tone="green"><CircleCheck /> Connected</Badge> : <Badge tone="red"><CircleX /> {c.status}</Badge>}
                  <Button variant="ghost" size="icon" onClick={() => setDel(c)} aria-label="Delete connection"><Trash2 /></Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <LineTabs value={tab} onChange={setTab} className="mt-8" tabs={[{ value: "all", label: "All" }, ...(catalog?.categories ?? []).filter((c) => c.id !== "file").map((c) => ({ value: c.id, label: `${c.label} (${c.connectors.length})` }))]} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-slate-500">{shown.length} connector{shown.length !== 1 ? "s" : ""}</div>
        <div className="flex items-center gap-2">
          <PillTabs value={role} onChange={setRole} tabs={[{ value: "all", label: "Any" }, { value: "source", label: "Sources" }, { value: "target", label: "Targets" }]} />
          <div className="relative w-60"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search connectors" className="pl-9" /></div>
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((c) => (
          <button key={c.id} onClick={() => setSpec(c)} className="glass lift flex items-start gap-3 rounded-[18px] p-4 text-left">
            <ConnectorIcon icon={c.icon} color={c.color} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 font-semibold text-slate-900">{c.name}{c.supports_cdc && <Badge tone="green">CDC</Badge>}{c.availability !== "ga" && <Badge tone="sky">Preview</Badge>}</div>
              <div className="mt-0.5 line-clamp-2 text-xs text-slate-500">{c.description}</div>
              <RoleChips roles={c.roles} className="mt-2" />
            </div>
          </button>
        ))}
      </div>
      <Dialog open={!!spec} onOpenChange={(v) => !v && setSpec(null)} title="New connection" size="lg">
        {spec && <ConnectionForm spec={spec} onConnect={save} connecting={saving} connectLabel="Save connection" defaultUsage={spec.roles.includes("source") ? "source" : "target"}
          initial={spec.id === "databricks" ? { use_for_deployment: !deployConn } : undefined} />}
      </Dialog>
      <ConfirmDialog open={!!del} onOpenChange={(v) => !v && setDel(null)} title="Delete connection?" description={<>Pipelines already using <b>{del?.name}</b> keep working until they're redeployed. Stored credentials are deleted.</>} destructive confirmLabel="Delete"
        onConfirm={async () => { try { await api.del(`/api/connections/${del!.id}`); toast.success("Connection deleted"); setDel(null); void reload(); } catch (e) { showError(e); } }} />
    </div>
  );
}
