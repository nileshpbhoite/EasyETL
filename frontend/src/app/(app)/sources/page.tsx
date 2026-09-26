"use client";

import { CircleCheck, CircleX, KeyRound, Plug, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectionForm, type ConnectionPayload } from "@/components/source/ConnectionForm";
import { ConnectorIcon } from "@/components/wizard/common";
import { Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, Input, Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { api } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import type { ConnectorSpec } from "@/lib/types";
import { timeAgo } from "@/lib/utils";

interface Conn { id: string; name: string; connector: string; status: string; info: Record<string, unknown>; has_secrets: boolean; created_at: string }

export default function SourcesPage() {
  const { data: catalog } = useApi<{ categories: { id: string; label: string; connectors: ConnectorSpec[] }[] }>("/api/connectors");
  const { data: conns, reload } = useApi<Conn[]>("/api/connections");
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [spec, setSpec] = useState<ConnectorSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState<Conn | null>(null);
  const specs = (catalog?.categories ?? []).flatMap((c) => c.connectors);
  const shown = (catalog?.categories ?? []).filter((c) => tab === "all" || c.id === tab).flatMap((c) => c.connectors).filter((c) => (c.name + c.description).toLowerCase().includes(q.toLowerCase()) && c.id !== "file_upload");

  const save = async (p: ConnectionPayload) => {
    setSaving(true);
    try {
      const res = await api.post<{ status: string; test: { ok: boolean; message: string } }>("/api/connections", p);
      if (res.test.ok) toast.success("✓ Connection saved", { description: "Credentials were encrypted in the secret store." });
      else toast.warning("Saved, but the connection test failed", { description: res.test.message });
      setSpec(null);
      void reload();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8 md:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
      <p className="mt-1 text-sm text-slate-500">Connect once, reuse in any pipeline. Every connector implements the same SDK: authenticate, test, discover, schema, profile, incremental & CDC detection.</p>
      <Card className="mt-6">
        <CardHeader title="Saved connections" description="Credentials are encrypted at rest and never shown again." icon={<KeyRound />} />
        {!conns?.length ? <EmptyState icon={<Plug />} title="No saved connections" description="Pick a connector below to add one." className="py-8" /> : (
          <div className="divide-y divide-slate-50">
            {conns.map((c) => {
              const s = specs.find((x) => x.id === c.connector);
              return (
                <div key={c.id} className="flex items-center gap-3 px-5 py-3">
                  {s && <ConnectorIcon icon={s.icon} color={s.color} size="sm" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-slate-500">{s?.name} · added {timeAgo(c.created_at)} {c.has_secrets && "· 🔒 credentials encrypted"}</div>
                  </div>
                  {c.status === "connected" ? <Badge tone="green"><CircleCheck /> Connected</Badge> : <Badge tone="red"><CircleX /> {c.status}</Badge>}
                  <Button variant="ghost" size="icon" onClick={() => setDel(c)} aria-label="Delete connection"><Trash2 /></Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            {(catalog?.categories ?? []).filter((c) => c.id !== "file").map((c) => <TabsTrigger key={c.id} value={c.id}>{c.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="relative w-64"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search connectors" className="pl-9" /></div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((c) => (
          <button key={c.id} onClick={() => setSpec(c)} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-card transition-all hover:-translate-y-0.5 hover:shadow-lift">
            <ConnectorIcon icon={c.icon} color={c.color} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 font-semibold">{c.name}{c.supports_cdc && <Badge tone="green">CDC</Badge>}{c.availability !== "ga" && <Badge tone="sky">Preview</Badge>}</div>
              <div className="mt-0.5 text-xs text-slate-500">{c.description}</div>
            </div>
          </button>
        ))}
      </div>
      <Dialog open={!!spec} onOpenChange={(v) => !v && setSpec(null)} title="New connection" size="lg">
        {spec && <ConnectionForm spec={spec} onConnect={save} connecting={saving} connectLabel="Save connection" />}
      </Dialog>
      <ConfirmDialog open={!!del} onOpenChange={(v) => !v && setDel(null)} title="Delete connection?" description={<>Pipelines already using <b>{del?.name}</b> keep working until they're redeployed. Stored credentials are deleted.</>} destructive confirmLabel="Delete"
        onConfirm={async () => { try { await api.del(`/api/connections/${del!.id}`); toast.success("Connection deleted"); setDel(null); void reload(); } catch (e) { showError(e); } }} />
    </div>
  );
}
