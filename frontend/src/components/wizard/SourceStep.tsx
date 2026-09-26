"use client";

import { CircleCheck, CloudUpload, Eye, LayoutGrid, Plug, RefreshCw, Search, Sparkles } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DataGrid } from "@/components/data/DataGrid";
import { ConnectionForm, type ConnectionPayload } from "@/components/source/ConnectionForm";
import { FileTypeIcon } from "@/components/source/FileTypeIcon";
import { uploadFile, type FileAsset } from "@/components/source/upload";
import { AIBadge, Badge, Button, Checkbox, Dialog, Input, Progress, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import type { ConnectorSpec, DatasetRef, Pipeline } from "@/lib/types";
import { cn, fmtBytes, fmtNumber, timeAgo } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { ConnectorIcon, LineTabs, NextButton, SectionCard, WizardFooter } from "./common";

type Tab = "all" | "file" | "application" | "database" | "cloud_storage" | "api";
const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" }, { value: "file", label: "Files" }, { value: "application", label: "Applications" },
  { value: "database", label: "Databases" }, { value: "cloud_storage", label: "Cloud Storage" }, { value: "api", label: "APIs" },
];
const FILE_TYPES = [
  { label: "Excel", fmt: "xlsx", accept: ".xlsx,.xlsm,.xls" }, { label: "CSV", fmt: "csv", accept: ".csv,.tsv" }, { label: "JSON", fmt: "json", accept: ".json,.jsonl,.ndjson" },
  { label: "XML", fmt: "xml", accept: ".xml" }, { label: "Parquet", fmt: "parquet", accept: ".parquet" }, { label: "TXT", fmt: "txt", accept: ".txt" }, { label: "ZIP", fmt: "zip", accept: ".zip,.gz" },
];
const FEATURED = ["salesforce", "sap", "oracle", "sqlserver", "snowflake", "servicenow", "workday", "mysql", "postgresql"];

function ConnectorTile({ c, active, onClick }: { c: ConnectorSpec; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn("flex h-[88px] flex-col items-center justify-center gap-2 rounded-xl border bg-white px-2 text-center transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-lift", active ? "border-brand-500 ring-2 ring-brand-100" : "border-slate-200")}>
      <ConnectorIcon icon={c.icon} color={c.color} size="sm" className="size-8 rounded-lg" />
      <span className="text-[12.5px] font-medium leading-tight text-slate-800">{c.name}</span>
    </button>
  );
}

function PreviewDialog({ pipelineId, ds, onClose }: { pipelineId: string; ds: DatasetRef | null; onClose: () => void }) {
  const { data, loading } = useApi<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; total_rows: number }>(ds ? `/api/pipelines/${pipelineId}/datasets/${ds.id}/preview?limit=100` : null, [ds?.id]);
  return (
    <Dialog open={!!ds} onOpenChange={(v) => !v && onClose()} title={ds?.name ?? ""} description="First 100 records, exactly as received" size="xl">
      {loading || !data ? <Skeleton className="h-80" /> : <DataGrid columns={data.columns} rows={data.rows as Record<string, any>[]} maxHeight={520} />}
    </Dialog>
  );
}

export function SourceStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const params = useSearchParams();
  const meta = pipeline.metadata;
  const src = meta.source;
  const { data: catalog } = useApi<{ categories: { id: string; label: string; connectors: ConnectorSpec[] }[] }>("/api/connectors");
  const { data: demoFiles } = useApi<{ name: string; description: string; size_bytes: number }[]>("/api/demo-files");
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) ?? "all");
  const [selected, setSelected] = useState<ConnectorSpec | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; pct: number }[]>([]);
  const [changing, setChanging] = useState(false);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState("");
  const [previewDs, setPreviewDs] = useState<DatasetRef | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const all = useMemo(() => (catalog?.categories ?? []).flatMap((c) => c.connectors).filter((c) => c.id !== "file_upload"), [catalog]);
  const systems = tab === "all" ? (showAll ? all : FEATURED.map((id) => all.find((c) => c.id === id)).filter((c): c is ConnectorSpec => !!c)) : all.filter((c) => c.category === tab);
  const connected = src.datasets.length > 0 && !changing;
  const fileIds = (src.config.file_ids as string[] | undefined) ?? [];
  const { data: firstFile } = useApi<FileAsset>(fileIds.length ? `/api/files/${fileIds[0]}` : null, [fileIds.join()]);

  const attachFiles = (ids: string[]) =>
    mutate("source", () => api.post<Pipeline & { test: { ok: boolean } }>(`/api/pipelines/${pipeline.id}/source`, { connector: "file_upload", file_ids: ids }), { success: "File uploaded successfully" });

  const onFiles = async (list: File[]) => {
    if (!list.length) return;
    setUploads(list.map((f) => ({ name: f.name, pct: 5 })));
    try {
      const assets: FileAsset[] = [];
      for (const [i, f] of list.entries()) assets.push(await uploadFile(f, (pct) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, pct } : x)))));
      setChanging(false);
      await attachFiles(assets.map((a) => a.id));
    } catch (e) {
      showError(e, "Upload failed");
    } finally {
      setUploads([]);
    }
  };
  const importDemo = async (name: string) => {
    setUploads([{ name, pct: 60 }]);
    try {
      const a = await api.post<FileAsset>(`/api/demo-files/${encodeURIComponent(name)}/import`);
      setChanging(false);
      await attachFiles([a.id]);
    } catch (e) {
      showError(e);
    } finally {
      setUploads([]);
    }
  };
  const connect = async (p: ConnectionPayload) => {
    const res = await mutate("source", () => api.post<Pipeline & { test: { ok: boolean; message: string; title: string } }>(`/api/pipelines/${pipeline.id}/source`, p));
    if (res && !res.test.ok) toast.error(res.test.title, { description: res.test.message });
    else if (res) {
      toast.success("Connection successful", { description: `${res.metadata.source.datasets.length} objects discovered` });
      setChanging(false);
      setSelected(null);
    }
  };
  const select = (sel: Record<string, boolean>) => mutate("select", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}/datasets`, { selected: sel }));
  const nSelected = src.datasets.filter((d) => d.selected).length;
  const totalRows = src.datasets.reduce((s, d) => s + (d.row_count ?? 0), 0);
  const noun = src.category === "file" ? (src.datasets.some((d) => d.kind === "sheet") ? "Sheets" : "Files") : src.category === "database" ? "Tables" : src.category === "api" ? "Endpoints" : "Objects";
  const uploading = uploads.length > 0 || busy === "source";

  if (connected) {
    const rows = src.datasets.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
    return (
      <div className="animate-fade-in space-y-5">
        <SectionCard icon={<Plug />} title="Select Source" subtitle="Your source is connected — choose what to bring into the Lakehouse" help="EasyETL detected the structure automatically. Unselected items are ignored."
          actions={<Button variant="secondary" size="sm" onClick={() => setChanging(true)}><RefreshCw /> Add or change source</Button>}>
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50/80 to-white p-4">
            {src.category === "file" ? <FileTypeIcon format={firstFile?.detection.format ?? src.datasets[0]?.format} size={38} /> : <div className="flex size-11 items-center justify-center rounded-xl bg-emerald-500 text-white"><Plug className="size-5" /></div>}
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-slate-900">
                {src.category === "file" ? (fileIds.length > 1 ? `${fileIds.length} files` : firstFile?.filename ?? "File") : src.name}
              </div>
              <div className="flex items-center gap-1.5 text-[13px] text-emerald-700"><CircleCheck className="size-4" /> {src.category === "file" ? "File uploaded successfully" : src.connection_info.message ?? "Connected"}</div>
              {src.category === "file" && firstFile && <div className="mt-1 text-xs text-slate-500">{firstFile.detection.summary.join(" · ")}</div>}
            </div>
            <dl className="grid grid-cols-3 gap-x-8 gap-y-1 text-sm">
              {src.category === "file" ? (
                <>
                  <dt className="text-xs text-slate-500">File size</dt><dt className="text-xs text-slate-500">{noun}</dt><dt className="text-xs text-slate-500">Total rows</dt>
                  <dd className="font-semibold">{fmtBytes(src.datasets.reduce((s, d) => Math.max(s, d.size_bytes ?? 0), 0) || firstFile?.size_bytes)}</dd><dd className="font-semibold">{src.datasets.length}</dd><dd className="font-semibold">{fmtNumber(totalRows)}</dd>
                </>
              ) : (
                Object.entries(src.connection_info.info ?? {}).slice(0, 3).map(([k, v]) => (
                  <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-semibold">{String(v)}</dd></div>
                ))
              )}
            </dl>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <div className="text-[15px] font-semibold text-slate-900">{noun} Found <span className="ml-1 text-sm font-normal text-slate-500">{nSelected} of {src.datasets.length} selected</span></div>
            <div className="flex items-center gap-2">
              {src.datasets.length > 6 && (
                <div className="relative w-56"><Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 pl-8 text-xs" /></div>
              )}
              <Button size="sm" variant="ghost" onClick={() => select(Object.fromEntries(src.datasets.map((d) => [d.id, nSelected !== src.datasets.length])))}>{nSelected === src.datasets.length ? "Clear all" : "Select all"}</Button>
            </div>
          </div>
          <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">
            {rows.map((d) => (
              <div key={d.id} onClick={() => select({ [d.id]: !d.selected })} className={cn("flex cursor-pointer items-center gap-4 px-4 py-3 hover:bg-slate-50/70", !d.selected && "opacity-70")}>
                <Checkbox checked={d.selected} onChange={(v) => select({ [d.id]: v })} disabled={busy === "select"} className="size-[18px]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-slate-900">{d.name.split(" › ").pop()}</div>
                  <div className="text-xs text-slate-500">{fmtNumber(d.row_count)} rows{d.modified_at ? ` · updated ${timeAgo(d.modified_at)}` : ""}</div>
                </div>
                <div className="hidden w-28 text-xs text-slate-500 sm:block">{d.column_count ?? "—"} columns</div>
                <div className="hidden w-40 md:block">{d.incremental_field ? <Badge tone="brand">Incremental: {d.incremental_field}</Badge> : null}</div>
                <div className="hidden w-24 md:block">{d.cdc_capable ? <Badge tone="green">CDC</Badge> : null}</div>
                <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setPreviewDs(d); }}><Eye /> Preview</Button>
              </div>
            ))}
          </div>
        </SectionCard>
        <WizardFooter note={`${nSelected} of ${src.datasets.length} selected · ${fmtNumber(src.datasets.filter((d) => d.selected).reduce((s, d) => s + (d.row_count ?? 0), 0))} rows`}
          primary={<NextButton disabled={nSelected === 0} onClick={() => goTo("analyze")}><Sparkles /> Analyze with AI</NextButton>} />
        <PreviewDialog pipelineId={pipeline.id} ds={previewDs} onClose={() => setPreviewDs(null)} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <SectionCard icon={<Plug />} title="Select Source" subtitle="Connect any source or upload a file" help="Files are detected automatically: format, encoding, sheets, nested structures and record counts.">
          <LineTabs value={tab} onChange={(v) => { setTab(v); setSelected(null); setShowAll(false); }} tabs={TABS} className="mb-4" />
          {(tab === "all" || tab === "file") && (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); void onFiles(Array.from(e.dataTransfer.files)); }}
                className={cn("flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all", over ? "border-brand-500 bg-brand-50" : "border-brand-300/70 bg-brand-50/40")}
              >
                <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && onFiles(Array.from(e.target.files))} />
                <div className="flex size-14 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-glow"><CloudUpload className="size-7" /></div>
                <div className="mt-3 text-[16px] font-semibold text-slate-900">{uploading ? "Uploading & detecting…" : "Drag & drop your file here"}</div>
                <div className="my-1.5 text-xs text-slate-500">or</div>
                <Button variant="primary" onClick={() => input.current?.click()} disabled={uploading}>Browse Files</Button>
                <div className="mt-3 text-xs text-slate-500">Excel, CSV, JSON, XML, Parquet, Avro, TXT, ZIP and more</div>
              </div>
              {uploads.length > 0 && (
                <div className="mt-3 space-y-2">
                  {uploads.map((u) => (
                    <div key={u.name} className="rounded-lg border border-slate-200 bg-white px-4 py-2">
                      <div className="mb-1.5 flex justify-between text-sm"><span className="font-medium">{u.name}</span><span className="text-slate-500">{u.pct < 100 ? "Uploading…" : "Detecting structure…"}</span></div>
                      <Progress value={u.pct} />
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-7">
                {FILE_TYPES.map((f) => (
                  <button key={f.label} onClick={() => { if (input.current) { input.current.accept = f.accept; input.current.click(); input.current.accept = ""; } }}
                    className="flex flex-col items-center gap-1.5 rounded-xl border border-slate-200 bg-white py-3 text-xs font-medium text-slate-700 transition-all hover:border-brand-300 hover:shadow-card">
                    <FileTypeIcon format={f.fmt} size={26} />
                    {f.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "all" && <div className="my-4 flex items-center gap-3 text-xs font-medium text-slate-400"><div className="h-px flex-1 bg-slate-200" />OR<div className="h-px flex-1 bg-slate-200" /></div>}
          {tab !== "file" && (
            <>
              <div className="mb-3 text-[15px] font-semibold text-slate-900">Connect a System</div>
              <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-5">
                {systems.map((c) => <ConnectorTile key={c.id} c={c} active={selected?.id === c.id} onClick={() => setSelected(c)} />)}
                {tab === "all" && !showAll && (
                  <button onClick={() => setShowAll(true)} className="flex h-[88px] flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-[12.5px] font-medium text-brand-600 hover:border-brand-300 hover:shadow-lift">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-brand-50"><LayoutGrid className="size-4" /></span>
                    View All
                  </button>
                )}
              </div>
            </>
          )}
        </SectionCard>

        <div className="space-y-5">
          {selected ? (
            <SectionCard title={`Connect to ${selected.name}`} subtitle="Friendly, no-code connection wizard">
              <ConnectionForm key={selected.id} spec={selected} onConnect={connect} connecting={busy === "source"} />
              {selected.demo_hint && (
                <div className="mt-4 flex gap-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
                  <Plug className="size-4 shrink-0" /> No system handy? Use <code className="rounded bg-white px-1 font-mono">{selected.demo_hint}</code> to explore a realistic demo source.
                </div>
              )}
            </SectionCard>
          ) : (
            <>
              <SectionCard title="Try with sample data" subtitle="Realistic, intentionally messy files that show what AI can fix" actions={<AIBadge label="Demo" />}>
                <div className="space-y-1.5">
                  {(demoFiles ?? []).map((f) => (
                    <button key={f.name} onClick={() => importDemo(f.name)} disabled={uploading} className="flex w-full items-center gap-3 rounded-xl border border-slate-100 px-3 py-2.5 text-left transition-colors hover:border-brand-200 hover:bg-brand-50/40 disabled:opacity-50">
                      <FileTypeIcon format={f.name.split(".").pop()} size={26} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-semibold text-slate-800">{f.name} <span className="font-normal text-slate-400">· {fmtBytes(f.size_bytes)}</span></div>
                        <div className="truncate text-xs text-slate-500">{f.description}</div>
                      </div>
                    </button>
                  ))}
                  {!demoFiles && <Skeleton className="h-40" />}
                </div>
              </SectionCard>
              <SectionCard title="What happens next" subtitle="You never write code">
                <ol className="space-y-3 text-[13px] text-slate-600">
                  {["We detect format, sheets, structure and record counts automatically.", "AI profiles your data and explains what it finds.", "You accept best-practice fixes with one click and preview every change.", "We design and deploy a governed Bronze → Silver → Gold Lakehouse on Databricks."].map((t, i) => (
                    <li key={t} className="flex gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{i + 1}</span>{t}</li>
                  ))}
                </ol>
              </SectionCard>
            </>
          )}
        </div>
      </div>
      {changing && src.datasets.length > 0 && (
        <WizardFooter secondary={<Button variant="ghost" onClick={() => setChanging(false)}>Cancel</Button>} />
      )}
    </div>
  );
}
