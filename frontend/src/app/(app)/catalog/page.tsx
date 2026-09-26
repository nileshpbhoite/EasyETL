"use client";

import { FlowArt } from "@/components/art";

import { ChevronRight, Database, GitBranch, KeyRound, Library, Lock, Search, Table2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { LineageGraph, type LineageData } from "@/components/lineage/LineageGraph";
import { Badge, Card, EmptyState, Input, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { api } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { cn, fmtNumber, qualityColor, timeAgo } from "@/lib/utils";

interface CatalogColumn { name: string; type: string; description: string; pii?: string | null; protection?: string | null; null_pct?: number; semantic_type?: string }
interface CatalogTable { name: string; fqn: string; layer: string; description: string; columns: CatalogColumn[]; row_count?: number | null; quality_score?: number | null; pii_count: number; source?: string; pipeline_id: string; pipeline_name: string; primary_key: string[]; cluster_by: string[]; last_updated: string; status: string; tags: Record<string, string>; owner?: string | null }
interface CatalogTree { name: string; schemas: { name: string; layer: string; tables: CatalogTable[] }[] }

const LAYER_TONE: Record<string, "bronze" | "silver" | "gold"> = { bronze: "bronze", silver: "silver", gold: "gold" };

function CatalogInner() {
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const { data, loading } = useApi<CatalogTree[]>(`/api/catalog?q=${encodeURIComponent(dq)}`, [dq]);
  const [sel, setSel] = useState<string | null>(params.get("table"));
  const [lineage, setLineage] = useState<LineageData | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const all = useMemo(() => (data ?? []).flatMap((c) => c.schemas.flatMap((s) => s.tables)), [data]);
  const table = all.find((t) => t.fqn === sel) ?? null;

  useEffect(() => {
    if (!sel && all[0]) setSel(all.find((t) => t.layer === "gold")?.fqn ?? all[0].fqn);
  }, [all, sel]);
  useEffect(() => {
    if (!table) return;
    setLineage(null);
    api.get<LineageData>(`/api/pipelines/${table.pipeline_id}/lineage`).then(setLineage).catch(() => undefined);
  }, [table?.pipeline_id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto max-w-[1600px] relative px-6 pb-10 pt-2 md:px-8">
      <FlowArt className="pointer-events-none absolute -top-4 right-8 hidden h-[130px] w-[260px] xl:block" />
      <h1 className="text-[32px] font-bold leading-tight text-slate-900">Data Catalog</h1>
      <p className="mt-1.5 max-w-3xl text-[15px] text-slate-600">Every table EasyETL designs or deploys, governed by Unity Catalog — with descriptions, PII classification, quality and lineage.</p>
      <div className="mt-6 grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="h-fit overflow-hidden">
          <div className="border-b border-slate-100 p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tables & columns" className="pl-8" />
            </div>
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-2 scrollbar-thin">
            {loading && !data && <Skeleton className="m-2 h-40" />}
            {data?.length === 0 && <div className="p-6 text-center text-sm text-slate-500">No tables found.</div>}
            {(data ?? []).map((c) => (
              <div key={c.name}>
                <div className="flex items-center gap-2 px-2 py-1.5 text-sm font-semibold text-slate-800"><Database className="size-4 text-brand-600" /> {c.name}</div>
                {c.schemas.map((s) => {
                  const key = `${c.name}.${s.name}`;
                  const isOpen = open[key] ?? true;
                  return (
                    <div key={key} className="ml-3">
                      <button onClick={() => setOpen({ ...open, [key]: !isOpen })} className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm text-slate-700 hover:bg-slate-50">
                        <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
                        <Badge tone={LAYER_TONE[s.layer]}>{s.layer}</Badge> {s.name}
                        <span className="ml-auto text-xs text-slate-400">{s.tables.length}</span>
                      </button>
                      {isOpen && s.tables.map((t) => (
                        <button key={t.fqn} onClick={() => setSel(t.fqn)} className={cn("ml-5 flex w-[calc(100%-1.25rem)] items-center gap-2 rounded px-2 py-1 text-left text-[13px]", sel === t.fqn ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50")}>
                          <Table2 className="size-3.5 shrink-0" /> <span className="truncate font-mono">{t.name}</span>
                          {t.pii_count > 0 && <Lock className="ml-auto size-3 shrink-0 text-rose-400" />}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Card>
        {table ? (
          <div className="space-y-5">
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><Badge tone={LAYER_TONE[table.layer]}>{table.layer}</Badge><Badge tone={table.status === "live" ? "green" : "slate"}>{table.status === "live" ? "Live on Databricks" : "Designed"}</Badge></div>
                  <div className="mt-2 break-all font-mono text-lg font-semibold text-slate-900">{table.fqn}</div>
                  <div className="mt-1 text-sm text-slate-600">{table.description}</div>
                  <div className="mt-2 flex flex-wrap gap-1">{Object.entries(table.tags).map(([k, v]) => <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{k}: {v}</span>)}</div>
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                  <div><dt className="text-xs text-slate-400">Records</dt><dd className="font-semibold">{fmtNumber(table.row_count)}</dd></div>
                  <div><dt className="text-xs text-slate-400">Quality</dt><dd className={cn("font-semibold", qualityColor(table.quality_score))}>{table.quality_score ? `${table.quality_score}%` : "—"}</dd></div>
                  <div><dt className="text-xs text-slate-400">Source</dt><dd className="font-semibold">{table.source}</dd></div>
                  <div><dt className="text-xs text-slate-400">Updated</dt><dd className="font-semibold">{timeAgo(table.last_updated)}</dd></div>
                </dl>
              </div>
            </Card>
            <Tabs defaultValue="columns">
              <TabsList><TabsTrigger value="columns"><Table2 /> Columns ({table.columns.length})</TabsTrigger><TabsTrigger value="lineage"><GitBranch /> Lineage</TabsTrigger></TabsList>
              <TabsContent value="columns" className="mt-4">
                <Card className="overflow-hidden">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">Column</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Description</th><th className="px-5 py-2 font-medium">Classification</th></tr></thead>
                    <tbody>
                      {table.columns.map((c) => (
                        <tr key={c.name} className="border-b border-slate-50">
                          <td className="px-5 py-2 font-mono text-[13px]"><span className="flex items-center gap-1.5">{table.primary_key.includes(c.name) && <KeyRound className="size-3.5 text-amber-500" />}{c.name}</span></td>
                          <td className="px-3 py-2 font-mono text-xs text-slate-500">{c.type}</td>
                          <td className="px-3 py-2 text-slate-600">{c.description}</td>
                          <td className="px-5 py-2">{c.pii ? <Badge tone="red"><Lock /> {c.pii.replace(/_/g, " ")}{c.protection && c.protection !== "tag" ? ` · ${c.protection}` : ""}</Badge> : <span className="text-xs text-slate-300">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </TabsContent>
              <TabsContent value="lineage" className="mt-4">
                {lineage ? <LineageGraph data={lineage} focus={`table:${table.name}`} /> : <Skeleton className="h-96" />}
                <div className="mt-2 text-xs text-slate-500">From pipeline “{table.pipeline_name}”.</div>
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          !loading && <Card><EmptyState icon={<Library />} title="Your catalog is empty" description="Design or deploy a pipeline and its tables will appear here." /></Card>
        )}
      </div>
    </div>
  );
}

export default function CatalogPage() {
  return <Suspense><CatalogInner /></Suspense>;
}
