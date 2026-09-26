"use client";

import { Archive, CircleCheck, FileJson, FileSpreadsheet, FileText, FileUp, Layers, Plug, RefreshCw, Search, Sparkles, Table2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AIBadge, Badge, Button, Callout, Card, CardHeader, Checkbox, Input, Progress, Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { ConnectionForm, type ConnectionPayload } from "@/components/source/ConnectionForm";
import { uploadFile, type FileAsset } from "@/components/source/upload";
import { api } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import type { ConnectorSpec, DatasetRef, Pipeline } from "@/lib/types";
import { cn, fmtBytes, fmtNumber, timeAgo } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { ConnectorIcon, NextButton, StepHeader, WizardFooter } from "./common";

const TABS = [
  { id: "file", label: "Files" },
  { id: "application", label: "Applications" },
  { id: "database", label: "Databases" },
  { id: "cloud_storage", label: "Cloud Storage" },
  { id: "api", label: "APIs" },
];
const FORMATS = ["Excel", "CSV", "JSON", "XML", "Parquet", "Avro", "TXT", "ZIP"];

function fileIcon(format?: string | null) {
  if (format === "xlsx") return FileSpreadsheet;
  if (format === "json" || format === "xml") return FileJson;
  if (format === "zip") return Archive;
  return FileText;
}

function Dropzone({ onFiles, busy }: { onFiles: (f: File[]) => void; busy: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
      className={cn(
        "grid-bg flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-all",
        over ? "scale-[1.01] border-brand-500 bg-brand-50/70" : "border-slate-300 bg-white hover:border-brand-400 hover:bg-brand-50/30",
      )}
    >
      <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && onFiles(Array.from(e.target.files))} />
      <div className="flex size-14 items-center justify-center rounded-2xl gradient-primary text-white shadow-glow">
        <FileUp className="size-7" />
      </div>
      <div className="mt-4 text-lg font-semibold text-slate-900">{busy ? "Uploading & detecting…" : "Drop anything here"}</div>
      <div className="mt-1 text-sm text-slate-500">or <span className="font-medium text-brand-600">browse your computer</span> — large files stream straight to cloud storage</div>
      <div className="mt-5 flex flex-wrap justify-center gap-1.5">
        {FORMATS.map((f) => (
          <span key={f} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

function DetectionCard({ fileId }: { fileId: string }) {
  const { data } = useApi<FileAsset>(`/api/files/${fileId}`);
  if (!data) return <Card className="h-28 p-4"><div className="skeleton h-4 w-40" /></Card>;
  const d = data.detection;
  const Icon = fileIcon(d.format);
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-slate-900">{data.filename}</span>
            <AIBadge label="Detected" />
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {d.format_label} · {fmtBytes(d.size_bytes)} {d.encoding && `· ${d.encoding}`} {d.compression && `· ${d.compression}`} · {d.structure.replace("_", " ")}
            {d.profiling_strategy === "databricks" && " · large file: profiled on Databricks"}
          </div>
          <ul className="mt-2 space-y-0.5">
            {d.summary.map((s) => (
              <li key={s} className="flex items-center gap-1.5 text-sm text-slate-700">
                <CircleCheck className="size-3.5 text-emerald-500" /> {s}
              </li>
            ))}
          </ul>
          {d.format === "zip" && (
            <div className="mt-3 overflow-hidden rounded-lg border border-slate-100">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr><th className="px-2 py-1 text-left">File</th><th className="px-2 py-1 text-left">Type</th><th className="px-2 py-1 text-right">Size</th><th className="px-2 py-1 text-right">Records</th></tr>
                </thead>
                <tbody>
                  {d.entries.map((e) => (
                    <tr key={e.name} className="border-t border-slate-100">
                      <td className="px-2 py-1">{e.name}</td>
                      <td className="px-2 py-1 uppercase">{e.format}</td>
                      <td className="px-2 py-1 text-right">{fmtBytes(e.size_bytes)}</td>
                      <td className="px-2 py-1 text-right">{e.supported === false ? "not supported" : fmtNumber(e.row_count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function DatasetPicker({ pipeline, onChange, saving }: { pipeline: Pipeline; onChange: (sel: Record<string, boolean>) => void; saving: boolean }) {
  const src = pipeline.metadata.source;
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "selected">("all");
  const rows = src.datasets.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()) && (only === "all" || d.selected));
  const allSel = src.datasets.every((d) => d.selected);
  const noun = src.category === "file" ? "files & sheets" : src.category === "database" ? "tables" : src.category === "api" ? "endpoints" : "objects";
  return (
    <Card>
      <CardHeader
        title={`Discovered ${src.datasets.length} ${noun}`}
        description="Choose what to bring into the Lakehouse. You can change this later."
        icon={<Layers />}
        actions={
          <>
            <div className="relative w-56">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 pl-8 text-xs" />
            </div>
            <Button size="sm" variant="ghost" onClick={() => setOnly(only === "all" ? "selected" : "all")}>{only === "all" ? "Show selected" : "Show all"}</Button>
          </>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
              <th className="w-10 px-5 py-2">
                <Checkbox checked={allSel} indeterminate={!allSel && src.datasets.some((d) => d.selected)} onChange={(v) => onChange(Object.fromEntries(src.datasets.map((d) => [d.id, v])))} />
              </th>
              <th className="px-2 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Records</th>
              <th className="px-3 py-2 text-right font-medium">Columns</th>
              <th className="px-3 py-2 font-medium">Modified</th>
              <th className="px-3 py-2 font-medium">Incremental field</th>
              <th className="px-5 py-2 font-medium">CDC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d: DatasetRef) => {
              const Icon = src.category === "file" ? fileIcon(d.format) : Table2;
              return (
                <tr key={d.id} className={cn("cursor-pointer border-b border-slate-50 hover:bg-slate-50/70", !d.selected && "text-slate-400")} onClick={() => onChange({ [d.id]: !d.selected })}>
                  <td className="px-5 py-2.5"><Checkbox checked={d.selected} onChange={(v) => onChange({ [d.id]: v })} disabled={saving} /></td>
                  <td className="px-2 py-2.5">
                    <div className="flex items-center gap-2 font-medium text-slate-800"><Icon className="size-4 text-slate-400" /> {d.name}</div>
                  </td>
                  <td className="px-3 py-2.5 text-xs uppercase text-slate-500">{d.kind.replace("_", " ")}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtNumber(d.row_count)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{d.column_count ?? "—"}</td>
                  <td className="px-3 py-2.5 text-slate-500">{timeAgo(d.modified_at)}</td>
                  <td className="px-3 py-2.5">{d.incremental_field ? <Badge tone="brand">{d.incremental_field}</Badge> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-5 py-2.5">{d.cdc_capable ? <Badge tone="green">Supported</Badge> : <span className="text-slate-300">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function SourceStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const params = useSearchParams();
  const meta = pipeline.metadata;
  const src = meta.source;
  const { data: catalog } = useApi<{ categories: { id: string; label: string; connectors: ConnectorSpec[] }[] }>("/api/connectors");
  const { data: demoFiles } = useApi<{ name: string; description: string; size_bytes: number }[]>("/api/demo-files");
  const [tab, setTab] = useState<string>(params.get("tab") ?? (src.category !== "none" ? src.category : "file"));
  const [selected, setSelected] = useState<ConnectorSpec | null>(null);
  const [uploads, setUploads] = useState<{ name: string; pct: number }[]>([]);
  const [changing, setChanging] = useState(false);

  const connectors = useMemo(() => catalog?.categories.find((c) => c.id === tab)?.connectors ?? [], [catalog, tab]);
  const connected = src.datasets.length > 0 && !changing;
  const fileIds = (src.config.file_ids as string[] | undefined) ?? [];

  useEffect(() => setSelected(null), [tab]);

  const attachFiles = async (ids: string[]) =>
    mutate("source", () => api.post<Pipeline & { test: { ok: boolean } }>(`/api/pipelines/${pipeline.id}/source`, { connector: "file_upload", file_ids: ids }), { success: "Files detected" });

  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploads(files.map((f) => ({ name: f.name, pct: 5 })));
    try {
      const assets: FileAsset[] = [];
      for (const [i, f] of files.entries()) {
        assets.push(await uploadFile(f, (pct) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, pct } : x)))));
      }
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
      toast.success("✓ Connection successful", { description: `${res.metadata.source.datasets.length} ${p.connector === "rest_api" ? "endpoint" : "objects"} discovered` });
      setChanging(false);
      setSelected(null);
    }
  };

  const select = (sel: Record<string, boolean>) => mutate("select", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}/datasets`, { selected: sel }));
  const nSelected = src.datasets.filter((d) => d.selected).length;

  return (
    <div className="animate-fade-in">
      <StepHeader
        eyebrow="Step 1 · Source"
        title={connected ? "Your data is connected" : "Connect anything"}
        description={connected ? "We automatically detected the structure of your source. Pick the datasets to include." : "Upload a file or connect an application, database, cloud storage or API. EasyETL detects everything automatically."}
        actions={connected && <Button variant="secondary" onClick={() => setChanging(true)}><RefreshCw /> Add or change source</Button>}
      />

      {!connected && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-5">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {!connected && tab === "file" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Dropzone onFiles={onFiles} busy={uploads.length > 0 || busy === "source"} />
            {uploads.length > 0 && (
              <div className="mt-4 space-y-2">
                {uploads.map((u) => (
                  <div key={u.name} className="rounded-lg border border-slate-200 bg-white px-4 py-2.5">
                    <div className="mb-1.5 flex justify-between text-sm"><span className="font-medium">{u.name}</span><span className="text-slate-500">{u.pct < 100 ? "Uploading…" : "Detecting structure…"}</span></div>
                    <Progress value={u.pct} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <Card className="h-fit">
            <CardHeader title="Try with sample data" description="Realistic, intentionally messy files" icon={<Sparkles />} />
            <div className="space-y-1 p-2">
              {(demoFiles ?? []).map((f) => {
                const Icon = fileIcon(f.name.split(".").pop());
                return (
                  <button key={f.name} onClick={() => importDemo(f.name)} disabled={uploads.length > 0} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-slate-50 disabled:opacity-50">
                    <Icon className="mt-0.5 size-4 shrink-0 text-brand-500" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800">{f.name} <span className="font-normal text-slate-400">· {fmtBytes(f.size_bytes)}</span></div>
                      <div className="text-xs text-slate-500">{f.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      {!connected && tab !== "file" && (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className={cn("grid content-start gap-3 sm:grid-cols-2", selected ? "lg:col-span-2 lg:grid-cols-1 xl:grid-cols-2" : "lg:col-span-5 lg:grid-cols-3 xl:grid-cols-4")}>
            {connectors.map((c) => (
              <button key={c.id} onClick={() => setSelected(c)} className={cn("flex items-start gap-3 rounded-xl border bg-white p-4 text-left shadow-card transition-all hover:-translate-y-0.5 hover:shadow-lift", selected?.id === c.id ? "border-brand-500 ring-2 ring-brand-100" : "border-slate-200")}>
                <ConnectorIcon icon={c.icon} color={c.color} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                    {c.name}
                    {c.supports_cdc && <Badge tone="green">CDC</Badge>}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-slate-500">{c.description}</div>
                </div>
              </button>
            ))}
          </div>
          {selected && (
            <Card className="p-6 lg:col-span-3">
              <ConnectionForm key={selected.id} spec={selected} onConnect={connect} connecting={busy === "source"} />
              {selected.demo_hint && (
                <Callout tone="info" className="mt-4" icon={<Plug />}>
                  No system handy? Use <code className="rounded bg-white px-1 font-mono text-xs">{selected.demo_hint}</code> to explore a realistic demo source.
                </Callout>
              )}
            </Card>
          )}
        </div>
      )}

      {connected && (
        <div className="space-y-6">
          {src.category === "file" ? (
            <div className="grid gap-4 md:grid-cols-2">
              {fileIds.map((id) => <DetectionCard key={id} fileId={id} />)}
            </div>
          ) : (
            src.connection_info?.ok && (
              <Card className="p-5">
                <div className="flex flex-wrap items-center gap-4">
                  <CircleCheck className="size-6 text-emerald-500" />
                  <div>
                    <div className="font-semibold text-slate-900">✓ Connection successful — {src.name}</div>
                    <div className="text-sm text-slate-500">{src.connection_info.message}</div>
                  </div>
                  <dl className="ml-auto flex flex-wrap gap-6 text-sm">
                    {Object.entries(src.connection_info.info ?? {}).map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs text-slate-400">{k}</dt>
                        <dd className="font-medium text-slate-800">{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </Card>
            )
          )}
          <DatasetPicker pipeline={pipeline} onChange={select} saving={busy === "select"} />
        </div>
      )}

      <WizardFooter
        note={connected ? `${nSelected} of ${src.datasets.length} selected` : undefined}
        secondary={changing && src.datasets.length > 0 ? <Button variant="ghost" onClick={() => setChanging(false)}>Cancel</Button> : undefined}
        primary={
          <NextButton disabled={!connected || nSelected === 0} onClick={() => goTo("analyze")}>
            <Sparkles /> Analyze with AI
          </NextButton>
        }
      />
    </div>
  );
}
