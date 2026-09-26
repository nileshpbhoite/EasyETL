"use client";

import {
  Braces, CircleCheck, CircleX, Code2, Download, Eye, FileSpreadsheet, ListChecks, OctagonX, PackageX, Plus, ShieldCheck, Sparkles, Trash2, TriangleAlert, Upload, Wand, WandSparkles,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Ring } from "@/components/charts/Mini";
import { DataGrid } from "@/components/data/DataGrid";
import { AIBadge, Badge, Button, Callout, Dialog, Field, Input, Select, Skeleton, Switch, Tabs, TabsList, TabsTrigger, Textarea, Tooltip } from "@/components/ui";
import { LineTabs, SectionCard } from "@/components/wizard/common";
import { api, getToken } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import type { ColumnInfo, DqAction, DqEvaluation, Pipeline, QualityConfig, QualityRule, Rag, RuleResult } from "@/lib/types";
import { cn, fmtNumber, humanize } from "@/lib/utils";

interface QualityData {
  datasets: { dataset_id: string; dataset: string; columns: string[]; profile_quality: Record<string, number> | null; before: DqEvaluation; after: DqEvaluation; anomalies: { column: string; outliers: number }[] }[];
  catalog: { rule: string; label: string; dimension: string; params: string[] }[];
  config: QualityConfig;
  actions: Record<DqAction, string>;
}

interface Draft {
  rule: QualityRule;
  sql: string | null;
  python: string | null;
  explanation?: string;
  engine?: string;
  preview: { records: number; failed: number; pass_rate?: number; rag?: Rag | null; columns: string[]; failing_rows: Record<string, unknown>[]; error?: string };
}

type Mutate = (l: string, fn: () => Promise<Pipeline>, o?: { success?: string }) => Promise<unknown>;

const ACTION_OPTS: { value: DqAction; label: string }[] = [
  { value: "flag", label: "Flag & load" }, { value: "quarantine", label: "Quarantine" }, { value: "drop", label: "Drop record" }, { value: "fail", label: "Fail the run" },
];
const SEVERITY_OPTS = ["critical", "high", "medium", "low"].map((s) => ({ value: s, label: humanize(s) }));
const ORIGIN: Record<string, { label: string; tone: "ai" | "sky" | "green" | "slate" | "amber" }> = {
  nl: { label: "Plain English", tone: "ai" }, excel: { label: "Excel", tone: "green" }, ai: { label: "AI recommended", tone: "ai" },
  recommendation: { label: "AI recommended", tone: "ai" }, template: { label: "Template", tone: "sky" }, user: { label: "Builder", tone: "slate" },
};

export function RagPill({ rag, className }: { rag?: Rag | null; className?: string }) {
  if (!rag) return <span className="text-xs text-slate-400">—</span>;
  const s = { green: "bg-emerald-50 text-emerald-700 ring-emerald-200", amber: "bg-amber-50 text-amber-700 ring-amber-200", red: "bg-rose-50 text-rose-700 ring-rose-200" }[rag];
  const d = { green: "bg-emerald-500", amber: "bg-amber-400", red: "bg-rose-500" }[rag];
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1", s, className)}><span className={cn("size-1.5 rounded-full", d)} />{rag}</span>;
}

function actionOf(r: { on_fail: string }): DqAction {
  return (r.on_fail === "warn" ? "flag" : r.on_fail) as DqAction;
}

function pyspark(sql: string, name: string) {
  const safe = name.toLowerCase().replace(/\W+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "rule";
  return `from pyspark.sql import functions as F\n\npasses_${safe} = F.coalesce(F.expr("""${sql}"""), F.lit(True))\n\nchecked = df.withColumn("_dq_${safe}", passes_${safe})\nfailures = checked.filter(~F.col("_dq_${safe}"))\n`;
}

function Code({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="max-h-56 overflow-auto rounded-xl bg-slate-900 p-3.5 font-mono text-[12px] leading-relaxed text-slate-100 scrollbar-thin">{children}</pre>
      <button onClick={() => { void navigator.clipboard?.writeText(children); toast.success("Copied"); }} className="absolute right-2 top-2 rounded-md bg-white/10 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-white/20">Copy</button>
    </div>
  );
}

async function downloadAuthed(path: string, fallbackName: string) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) throw new Error("Download failed");
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------ plain English
function examplesFor(cols: string[]): string[] {
  const find = (re: RegExp) => cols.find((c) => re.test(c));
  const email = find(/mail/i), date = find(/date|_at$|dob|birth/i), id = find(/(^|_)id$/i), status = find(/status|state|stage/i), num = find(/amount|revenue|price|points|total|qty|quantity/i);
  const out: string[] = [];
  if (email) out.push(`${email} must be a valid email address`);
  if (date) out.push(`${date} cannot be in the future`);
  if (id) out.push(`${id} must be unique, quarantine duplicates`);
  if (num) out.push(`${num} must not be negative`);
  if (status && date) out.push(`If ${status} is Closed then ${date} is required`);
  return out.slice(0, 4);
}

function PlainEnglish({ pipeline, datasetId, columns, defaultAction, onAdded }: { pipeline: Pipeline; datasetId: string; columns: string[]; defaultAction: DqAction; onAdded: () => void }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState<"sql" | "python">("sql");
  const [editSql, setEditSql] = useState<string | null>(null);
  const [opts, setOpts] = useState<{ name: string; severity: string; on_fail: DqAction; green: number; amber: number }>({ name: "", severity: "medium", on_fail: defaultAction, green: 99, amber: 95 });

  const generate = async (input = text) => {
    if (!input.trim()) return;
    setLoading(true);
    try {
      const d = await api.post<Draft>(`/api/pipelines/${pipeline.id}/quality-rules/draft`, { dataset_id: datasetId, text: input });
      setDraft(d);
      setEditSql(null);
      setOpts({ name: d.rule.name ?? input, severity: d.rule.severity, on_fail: actionOf(d.rule), green: d.rule.threshold_green, amber: d.rule.threshold_amber });
    } catch (e) {
      setDraft(null);
      showError(e);
    } finally {
      setLoading(false);
    }
  };
  const add = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.post<Pipeline>(`/api/pipelines/${pipeline.id}/quality-rules`, {
        ...draft.rule, name: opts.name, description: opts.name, severity: opts.severity, on_fail: opts.on_fail, threshold_green: opts.green, threshold_amber: opts.amber, origin: "nl",
      });
      toast.success("Rule added", { description: "It runs as part of the pipeline on Databricks." });
      setDraft(null);
      setText("");
      onAdded();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div>
        <Field label="Describe the rule in plain English — or type a SQL condition" help="EasyETL turns it into a validated Databricks SQL rule and shows how many records fail before you add it.">
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Ship date must be after order date — quarantine failures"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate(); }} />
        </Field>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {examplesFor(columns).map((ex) => (
            <button key={ex} onClick={() => { setText(ex); void generate(ex); }} className="rounded-full bg-white/85 px-3 py-1 text-[12px] text-slate-600 ring-1 ring-slate-200 hover:text-brand-700 hover:ring-brand-300">{ex}</button>
          ))}
        </div>
        <Button variant="primary" className="mt-4" onClick={() => generate()} loading={loading} disabled={text.trim().length < 4}><WandSparkles /> Generate rule</Button>
        <div className="mt-4 text-[12px] leading-relaxed text-slate-500">
          Understands phrases like <i>must be unique</i>, <i>is required</i>, <i>valid email/phone/date</i>, <i>between 1 and 5</i>, <i>not in the future</i>, <i>after &lt;other column&gt;</i>,
          <i> one of A, B, C</i>, <i>5 digits</i>, <i>if … then …</i>. Add <i>quarantine</i>, <i>flag</i>, <i>drop</i> or <i>fail the pipeline</i> to choose what happens to failing records.
        </div>
      </div>
      <div>
        {!draft ? (
          <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-brand-100 bg-brand-50/30 p-6 text-center">
            <Sparkles className="size-7 text-ai-500" />
            <div className="mt-2 font-semibold text-slate-800">Your rule will appear here</div>
            <div className="mt-1 max-w-sm text-[13px] text-slate-500">With the generated SQL and PySpark, and a live check against your data.</div>
          </div>
        ) : (
          <div className="glass-inset space-y-4 rounded-2xl p-4 animate-slide-up">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <Input value={opts.name} onChange={(e) => setOpts({ ...opts, name: e.target.value })} className="font-semibold" aria-label="Rule name" />
                {draft.explanation && <div className="mt-1.5 text-[12.5px] text-slate-600">{draft.explanation}</div>}
              </div>
              <Badge tone={draft.engine === "claude" ? "ai" : "brand"}>{draft.engine === "claude" ? "Claude" : draft.engine === "sql" ? "Your SQL" : "Rules engine"}</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-4 rounded-xl bg-white/80 px-4 py-3 ring-1 ring-slate-200/70">
              <Ring value={draft.preview.pass_rate} size={46} stroke={6} label={<span className="text-[11px] font-bold">{Math.round(draft.preview.pass_rate ?? 0)}%</span>} />
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="font-semibold text-slate-900">{fmtNumber(draft.preview.failed)} of {fmtNumber(draft.preview.records)} records fail</div>
                <div className="text-slate-500">on the current data after transformations</div>
              </div>
              <RagPill rag={draft.preview.rag} />
            </div>
            {draft.preview.error && <Callout tone="danger">{draft.preview.error}</Callout>}
            {draft.preview.failing_rows.length > 0 && (
              <DataGrid columns={draft.preview.columns.map((c) => ({ name: c, highlight: "changed" as const }))} rows={draft.preview.failing_rows as Record<string, unknown>[]} maxHeight={170} />
            )}
            {draft.sql && (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <LineTabs value={code} onChange={setCode} tabs={[{ value: "sql", label: "Databricks SQL" }, { value: "python", label: "PySpark" }]} className="flex-1" />
                  {editSql === null && draft.rule.rule === "expression" && <Button size="sm" variant="ghost" onClick={() => setEditSql(draft.sql ?? "")}><Code2 /> Edit SQL</Button>}
                </div>
                {editSql !== null ? (
                  <div className="space-y-2">
                    <Textarea rows={3} value={editSql} onChange={(e) => setEditSql(e.target.value)} className="font-mono text-[12px]" />
                    <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => generate(editSql)} loading={loading}>Validate & re-check</Button><Button size="sm" variant="ghost" onClick={() => setEditSql(null)}>Cancel</Button></div>
                  </div>
                ) : <Code>{code === "sql" ? draft.sql : draft.python ?? pyspark(draft.sql, opts.name)}</Code>}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Severity"><Select value={opts.severity} onChange={(v) => setOpts({ ...opts, severity: v })} options={SEVERITY_OPTS} /></Field>
              <Field label="On failure"><Select value={opts.on_fail} onChange={(v) => setOpts({ ...opts, on_fail: v as DqAction })} options={ACTION_OPTS} /></Field>
              <Field label="Green ≥ %"><Input type="number" value={opts.green} onChange={(e) => setOpts({ ...opts, green: Number(e.target.value) })} /></Field>
              <Field label="Amber ≥ %"><Input type="number" value={opts.amber} onChange={(e) => setOpts({ ...opts, amber: Number(e.target.value) })} /></Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
              <Button variant="primary" onClick={add} loading={saving} disabled={opts.amber > opts.green}><Plus /> Add rule to pipeline</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Excel
interface ImportRow { row: number; ok: boolean; error?: string; input?: string; how?: string; dataset?: string; summary?: string; rule?: QualityRule; preview?: { pass_rate?: number; failed?: number; rag?: Rag } }

function ExcelImport({ pipeline, onImported }: { pipeline: Pipeline; onImported: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ rows: ImportRow[]; valid: number; invalid: number } | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | "template" | null>(null);
  const send = async (f: File, dry: boolean) => {
    const form = new FormData();
    form.append("file", f);
    form.append("dry_run", dry ? "true" : "false");
    return api.upload<{ rows: ImportRow[]; valid: number; invalid: number; dry_run: boolean }>(`/api/pipelines/${pipeline.id}/quality-rules/import`, form);
  };
  const check = async (f: File) => {
    setFile(f);
    setBusy("check");
    try {
      setResult(await send(f, true));
    } catch (e) {
      setResult(null);
      showError(e);
    } finally {
      setBusy(null);
    }
  };
  const doImport = async () => {
    if (!file) return;
    setBusy("import");
    try {
      const r = await send(file, false);
      toast.success(`Imported ${r.valid} rule${r.valid !== 1 ? "s" : ""}`, { description: r.invalid ? `${r.invalid} row(s) skipped — see the errors.` : "All rows imported." });
      setResult(null);
      setFile(null);
      onImported();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="rounded-2xl bg-gradient-to-br from-emerald-50 to-white p-4 ring-1 ring-emerald-100">
          <div className="flex items-center gap-2 font-semibold text-slate-900"><FileSpreadsheet className="size-5 text-emerald-600" /> 1. Download the template</div>
          <p className="mt-1.5 text-[13px] text-slate-600">
            Pre-filled with this pipeline&apos;s datasets and columns, examples and dropdowns. Write each rule as a <b>SQL condition</b>, a <b>rule type</b> or in <b>plain English</b>,
            and set <b>Severity</b>, <b>On failure</b> and the <b>Red/Amber/Green</b> thresholds.
          </p>
          <Button className="mt-3" variant="secondary" loading={busy === "template"}
            onClick={async () => { setBusy("template"); try { await downloadAuthed(`/api/pipelines/${pipeline.id}/quality-rules/template`, "dq_rules.xlsx"); } catch (e) { showError(e); } finally { setBusy(null); } }}>
            <Download /> Download template (.xlsx)
          </Button>
        </div>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void check(f); }}
          className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-brand-200 bg-brand-50/30 p-5 text-center">
          <input ref={input} type="file" accept=".xlsx,.xlsm,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void check(f); e.target.value = ""; }} />
          <Upload className="size-6 text-brand-500" />
          <div className="mt-2 font-semibold text-slate-800">2. Upload your rules</div>
          <div className="text-[12.5px] text-slate-500">Excel (.xlsx) or CSV — you&apos;ll see a check of every row before anything is added</div>
          <Button className="mt-3" variant="primary" onClick={() => input.current?.click()} loading={busy === "check"}><Upload /> Choose file</Button>
        </div>
      </div>
      {result && (
        <div className="glass-inset overflow-hidden rounded-2xl animate-slide-up">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="font-semibold text-slate-900">{file?.name}</div>
            <Badge tone="green"><CircleCheck /> {result.valid} valid</Badge>
            {result.invalid > 0 && <Badge tone="red"><CircleX /> {result.invalid} with errors</Badge>}
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={() => { setResult(null); setFile(null); }}>Cancel</Button>
              <Button variant="primary" onClick={doImport} loading={busy === "import"} disabled={!result.valid}><ListChecks /> Import {result.valid} rule{result.valid !== 1 ? "s" : ""}</Button>
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto scrollbar-thin">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-2">Row</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Written as</th><th className="px-2 py-2">Rule</th><th className="px-2 py-2">On failure</th><th className="px-4 py-2 text-right">Check</th></tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.row} className="border-t border-slate-200/50 align-top">
                    <td className="px-4 py-2 tabular-nums text-slate-400">{r.row}</td>
                    <td className="px-2 py-2">{r.ok ? <CircleCheck className="size-4 text-emerald-500" /> : <CircleX className="size-4 text-rose-500" />}</td>
                    <td className="px-2 py-2 text-slate-500">{r.how ?? "—"}</td>
                    <td className="px-2 py-2">
                      {r.ok ? <><div className="font-medium text-slate-800">{r.rule?.name}</div><code className="text-[11.5px] text-slate-500">{r.summary}</code></> :
                        <><div className="text-slate-600">{r.input}</div><div className="text-rose-600">{r.error}</div></>}
                    </td>
                    <td className="px-2 py-2 text-slate-600">{r.rule ? ACTION_OPTS.find((o) => o.value === actionOf(r.rule!))?.label : ""}</td>
                    <td className="px-4 py-2 text-right">{r.preview ? <span className="inline-flex items-center gap-2"><span className="tabular-nums text-slate-600">{r.preview.pass_rate}%</span><RagPill rag={r.preview.rag} /></span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ builder
function Builder({ pipeline, datasetId, catalog, defaultAction, onCreate }: { pipeline: Pipeline; datasetId: string; catalog: QualityData["catalog"]; defaultAction: DqAction; onCreate: (r: Record<string, unknown>) => Promise<void> }) {
  const { data: columns } = useApi<ColumnInfo[]>(`/api/pipelines/${pipeline.id}/datasets/${datasetId}/columns`, [datasetId]);
  const [rule, setRule] = useState("not_null");
  const [column, setColumn] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [onFail, setOnFail] = useState<DqAction>(defaultAction);
  const [severity, setSeverity] = useState("medium");
  const [saving, setSaving] = useState(false);
  const spec = catalog.find((c) => c.rule === rule);
  const others = pipeline.metadata.source.datasets.filter((d) => d.selected && d.id !== datasetId);
  const submit = async () => {
    setSaving(true);
    const p: Record<string, unknown> = { ...params };
    if (rule === "in_set") p.values = String(params.values ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (rule === "in_reference") p.reference = "iso_countries";
    await onCreate({ dataset_id: datasetId, column: rule === "expression" ? null : column, rule, params: p, on_fail: onFail, severity, origin: "user" });
    setSaving(false);
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Field label="Rule" required><Select value={rule} onChange={(v) => { setRule(v); setParams({}); }} options={catalog.map((c) => ({ value: c.rule, label: c.label }))} /></Field>
      {rule !== "expression" && <Field label="Column" required><Select value={column} onChange={setColumn} placeholder="Choose column" options={(columns ?? []).map((c) => ({ value: c.name, label: c.name }))} /></Field>}
      {rule === "expression" && <Field label="SQL condition (TRUE = valid record)" className="sm:col-span-2 xl:col-span-3"><Input value={params.sql ?? ""} onChange={(e) => setParams({ sql: e.target.value })} placeholder="amount >= 0 AND currency IN ('USD','EUR')" className="font-mono" /></Field>}
      {spec?.params.includes("min") && <Field label="Minimum"><Input value={params.min ?? ""} onChange={(e) => setParams({ ...params, min: e.target.value })} placeholder="e.g. 0 or 1900-01-01" /></Field>}
      {spec?.params.includes("max") && <Field label="Maximum"><Input value={params.max ?? ""} onChange={(e) => setParams({ ...params, max: e.target.value })} placeholder="e.g. 100 or today" /></Field>}
      {spec?.params.includes("values") && <Field label="Allowed values" className="sm:col-span-2"><Input value={params.values ?? ""} onChange={(e) => setParams({ ...params, values: e.target.value })} placeholder="Active, Inactive, Pending" /></Field>}
      {spec?.params.includes("pattern") && <Field label="Pattern (regex)"><Input value={params.pattern ?? ""} onChange={(e) => setParams({ ...params, pattern: e.target.value })} placeholder="^[0-9]{5}$" className="font-mono" /></Field>}
      {spec?.params.includes("length") && <Field label="Minimum length"><Input type="number" value={params.length ?? ""} onChange={(e) => setParams({ ...params, length: e.target.value })} /></Field>}
      {spec?.params.includes("dataset_id") && (
        <>
          <Field label="Must exist in dataset"><Select value={params.dataset_id ?? ""} onChange={(v) => setParams({ ...params, dataset_id: v })} placeholder="Choose" options={others.map((d) => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Column in that dataset"><Input value={params.column ?? ""} onChange={(e) => setParams({ ...params, column: e.target.value })} placeholder="customer_id" /></Field>
        </>
      )}
      <Field label="Severity"><Select value={severity} onChange={setSeverity} options={SEVERITY_OPTS} /></Field>
      <Field label="On failure"><Select value={onFail} onChange={(v) => setOnFail(v as DqAction)} options={ACTION_OPTS} /></Field>
      <div className="flex items-end sm:col-span-2 xl:col-span-4">
        <Button variant="primary" onClick={submit} loading={saving} disabled={rule === "expression" ? !params.sql : !column}><Plus /> Add rule</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ failures & code dialogs
function FailuresDialog({ pipelineId, rule, onClose }: { pipelineId: string; rule: RuleResult | null; onClose: () => void }) {
  const { data, loading } = useApi<{ total: number; columns: string[]; highlight: string[]; rows: Record<string, unknown>[]; action: DqAction }>(
    rule ? `/api/pipelines/${pipelineId}/quality-rules/${rule.rule_id}/failures?limit=200` : null, [rule?.rule_id]);
  const where = { flag: "loaded with _dq_issues / _dq_status flags", quarantine: "parked in the DQ quarantine table (not loaded)", drop: "dropped", fail: "stopping the run" };
  return (
    <Dialog open={!!rule} onOpenChange={(v) => !v && onClose()} title={rule?.name ?? ""} size="xl"
      description={data ? `${fmtNumber(data.total)} failing records — on Databricks these are ${where[data.action]}. Showing up to 200.` : "Loading…"}>
      {loading || !data ? <Skeleton className="h-72" /> : (
        <DataGrid columns={data.columns.map((c) => ({ name: c, highlight: data.highlight.includes(c) ? ("changed" as const) : undefined }))} rows={data.rows as Record<string, unknown>[]} maxHeight={480} emptyText="No failing records" />
      )}
    </Dialog>
  );
}

function RuleDetailsDialog({ pipeline, rule, result, onClose, onSave }: { pipeline: Pipeline; rule: QualityRule | null; result?: RuleResult; onClose: () => void; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
  const [green, setGreen] = useState(rule?.threshold_green ?? 99);
  const [amber, setAmber] = useState(rule?.threshold_amber ?? 95);
  const [tab, setTab] = useState<"sql" | "python">("sql");
  const sql = result?.sql;
  return (
    <Dialog open={!!rule} onOpenChange={(v) => !v && onClose()} title={rule?.name || rule?.description || ""} description={rule?.source_text ? `“${rule.source_text}”` : undefined} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" disabled={amber > green} onClick={() => onSave({ threshold_green: green, threshold_amber: amber })}>Save thresholds</Button></>}>
      <div className="space-y-4">
        {sql ? (
          <>
            <LineTabs value={tab} onChange={setTab} tabs={[{ value: "sql", label: "Databricks SQL" }, { value: "python", label: "PySpark" }]} />
            <Code>{tab === "sql" ? `-- TRUE = the record passes (NULL counts as passing)\n${sql}` : pyspark(sql, rule?.name ?? "rule")}</Code>
          </>
        ) : (
          <Callout tone="info">This rule compares rows with each other ({rule?.rule === "unique" ? "uniqueness" : "reference lookup"}), so EasyETL evaluates it with a window/join in the generated pipeline instead of a single-row SQL condition.</Callout>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Green when pass rate ≥ %"><Input type="number" value={green} onChange={(e) => setGreen(Number(e.target.value))} /></Field>
          <Field label="Amber when pass rate ≥ %" help="Below this the rule is Red"><Input type="number" value={amber} onChange={(e) => setAmber(Number(e.target.value))} /></Field>
        </div>
        <div className="text-xs text-slate-500">Rule type: {humanize(rule?.rule ?? "")} · dimension: {humanize(rule?.dimension ?? "")} · pipeline <code>{pipeline.name}</code></div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ main panel
export function QualityPanel({ pipeline, mutate }: { pipeline: Pipeline; mutate: Mutate }) {
  const meta = pipeline.metadata;
  const cfg = meta.quality ?? { default_action: "quarantine", dq_schema: "dq", add_dq_columns: true, fail_run_below: null };
  const { data, loading, reload } = useApi<QualityData>(`/api/pipelines/${pipeline.id}/quality`, [meta.quality_rules.length, meta.transformations.length, JSON.stringify(meta.quality_rules.map((r) => [r.on_fail, r.enabled, r.threshold_green, r.threshold_amber]))]);
  const [ds, setDs] = useState<string>(meta.source.datasets.find((d) => d.selected)?.id ?? "");
  const [how, setHow] = useState<"text" | "excel" | "builder">("text");
  const [failures, setFailures] = useState<RuleResult | null>(null);
  const [details, setDetails] = useState<QualityRule | null>(null);
  const [minScore, setMinScore] = useState<string>(cfg.fail_run_below != null ? String(cfg.fail_run_below) : "");
  const cur = data?.datasets.find((d) => d.dataset_id === ds) ?? data?.datasets[0];
  const rules = meta.quality_rules.filter((r) => r.dataset_id === (cur?.dataset_id ?? ds));
  const resultOf = (id: string) => cur?.after.rules.find((r) => r.rule_id === id);
  const setRule = (id: string, patch: Record<string, unknown>) => mutate("rule", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}/quality-rules/${id}`, patch));
  const setCfg = (body: Record<string, unknown>, msg: string) => mutate("dqcfg", () => api.put<Pipeline>(`/api/pipelines/${pipeline.id}/quality-config`, body), { success: msg });
  const h = cur?.after.handling;
  const bars = useMemo(() => {
    if (!h || !cur?.after.records) return [];
    const n = cur.after.records;
    return [
      { k: "Loaded clean", v: h.loaded - h.flagged, c: "bg-emerald-500" }, { k: "Loaded with flags", v: h.flagged, c: "bg-amber-400" },
      { k: "Quarantined", v: h.quarantined, c: "bg-ai-500" }, { k: "Dropped", v: h.dropped, c: "bg-rose-500" },
    ].map((b) => ({ ...b, pct: (b.v / n) * 100 }));
  }, [h, cur]);

  return (
    <div className="space-y-5">
      {(data?.datasets.length ?? 0) > 1 && (
        <Tabs value={cur?.dataset_id ?? ds} onValueChange={setDs}>
          <TabsList>{(data?.datasets ?? []).map((d) => <TabsTrigger key={d.dataset_id} value={d.dataset_id}>{d.dataset.split(" › ").pop()}</TabsTrigger>)}</TabsList>
        </Tabs>
      )}
      {loading && !data ? <Skeleton className="h-72" /> : cur && (
        <>
          {/* Scoring */}
          <SectionCard icon={<ShieldCheck />} title="Data Quality Score" subtitle={`${cur.dataset.split(" › ").pop()} · ${fmtNumber(cur.after.records)} records checked after transformations · weighted by rule severity`}>
            <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="flex items-center gap-4">
                <Ring value={cur.after.score} size={104} stroke={11} label={<span className="text-center"><span className="block text-[22px] font-bold text-slate-900">{cur.after.score ?? "—"}{cur.after.score != null && "%"}</span><span className="block text-[10.5px] text-slate-500">DQ score</span></span>} />
                <div className="space-y-1 text-[13px] text-slate-600">
                  <div>Before transformations: <b>{cur.before.score ?? "—"}%</b></div>
                  <div>{rules.filter((r) => r.enabled).length} active rules · <b>{fmtNumber(cur.after.issues)}</b> issues</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 self-center">
                {(["green", "amber", "red"] as Rag[]).map((k) => (
                  <div key={k} className={cn("rounded-2xl p-3 text-center ring-1", { green: "bg-emerald-50/80 ring-emerald-100", amber: "bg-amber-50/80 ring-amber-100", red: "bg-rose-50/80 ring-rose-100" }[k])}>
                    <div className={cn("font-display text-[26px] font-bold", { green: "text-emerald-600", amber: "text-amber-600", red: "text-rose-600" }[k])}>{cur.after.rag?.[k] ?? 0}</div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k} rules</div>
                  </div>
                ))}
              </div>
              <div className="self-center">
                <div className="mb-2 text-[13px] font-semibold text-slate-800">What happens to the records when the pipeline runs</div>
                <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
                  {bars.map((b) => b.v > 0 && <Tooltip key={b.k} content={`${b.k}: ${fmtNumber(b.v)}`}><span className={cn("h-full", b.c)} style={{ width: `${Math.max(b.pct, 0.8)}%` }} /></Tooltip>)}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
                  {bars.map((b) => <span key={b.k} className="flex items-center gap-2 text-slate-600"><span className={cn("size-2 rounded-full", b.c)} />{b.k}<b className="ml-auto tabular-nums text-slate-900">{fmtNumber(b.v)}</b></span>)}
                </div>
                {h && h.fail_rules_triggered > 0 && <div className="mt-2 flex items-center gap-1.5 text-[12.5px] font-medium text-rose-600"><OctagonX className="size-4" />{h.fail_rules_triggered} “fail the run” rule(s) would stop the pipeline</div>}
              </div>
            </div>
          </SectionCard>

          {/* Handling */}
          <SectionCard icon={<PackageX />} title="Records that fail a rule" subtitle="Choose whether failing records are parked for review or still loaded — with their issues highlighted.">
            <div className="grid gap-4 lg:grid-cols-2">
              {([
                { v: "quarantine", title: "Quarantine (park in a DQ table)", body: <>Failing records go to <code>{meta.lakehouse.catalog}.{cfg.dq_schema}.&lt;table&gt;_quarantine</code> with the reasons, and are <b>not</b> loaded to the target until fixed.</>, icon: <PackageX /> },
                { v: "flag", title: "Flag & load (highlight the issues)", body: <>Failing records are loaded to the target with <code>_dq_issues</code> (which rules failed) and <code>_dq_status</code>, so consumers can filter or fix them.</>, icon: <TriangleAlert /> },
              ] as const).map((o) => (
                <button key={o.v} type="button" onClick={() => cfg.default_action !== o.v && setCfg({ default_action: o.v }, "Default handling updated")}
                  className={cn("flex gap-3 rounded-2xl border-2 p-4 text-left transition-all [&_svg]:size-5",
                    cfg.default_action === o.v ? "border-brand-400 bg-brand-50/60" : "border-slate-200/70 bg-white/60 hover:border-brand-200")}>
                  <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl", cfg.default_action === o.v ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-500")}>{o.icon}</span>
                  <span><span className="block font-semibold text-slate-900">{o.title} {cfg.default_action === o.v && <Badge tone="brand" className="ml-1">Default</Badge>}</span><span className="mt-1 block text-[13px] text-slate-600">{o.body}</span></span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Button variant="secondary" size="sm" onClick={() => setCfg({ apply_to_all: true }, "Applied to all flag/quarantine rules")}>Apply default to all rules</Button>
              <Switch checked={cfg.add_dq_columns} onCheckedChange={(v) => setCfg({ add_dq_columns: v }, v ? "DQ columns will be added" : "DQ columns removed")} label="Add _dq_issues / _dq_status columns to loaded records" />
              <div className="flex items-center gap-2 text-[13px] text-slate-600">
                Stop the run if the DQ score falls below
                <Input className="w-20" type="number" value={minScore} onChange={(e) => setMinScore(e.target.value)} placeholder="off"
                  onBlur={() => { const v = minScore.trim(); if ((v === "" ? null : Number(v)) !== (cfg.fail_run_below ?? null)) void setCfg(v === "" ? { clear_fail_threshold: true } : { fail_run_below: Number(v) }, "Run threshold updated"); }} />%
              </div>
            </div>
          </SectionCard>

          {/* Authoring */}
          <SectionCard icon={<Wand />} title="Add rules" subtitle="Three ways — whichever suits you. Every rule is validated and checked against your data before it's added.">
            <LineTabs value={how} onChange={setHow} className="mb-5" tabs={[
              { value: "text", label: <span className="inline-flex items-center gap-1.5"><Sparkles className="size-4" /> Describe in plain English</span> },
              { value: "excel", label: <span className="inline-flex items-center gap-1.5"><FileSpreadsheet className="size-4" /> Upload Excel</span> },
              { value: "builder", label: <span className="inline-flex items-center gap-1.5"><Braces className="size-4" /> Rule builder</span> },
            ]} />
            {how === "text" && <PlainEnglish key={cur.dataset_id} pipeline={pipeline} datasetId={cur.dataset_id} columns={cur.columns ?? []} defaultAction={cfg.default_action} onAdded={() => mutate("reload", () => api.get<Pipeline>(`/api/pipelines/${pipeline.id}`))} />}
            {how === "excel" && <ExcelImport pipeline={pipeline} onImported={() => mutate("reload", () => api.get<Pipeline>(`/api/pipelines/${pipeline.id}`))} />}
            {how === "builder" && data && <Builder key={cur.dataset_id} pipeline={pipeline} datasetId={cur.dataset_id} catalog={data.catalog} defaultAction={cfg.default_action}
              onCreate={async (r) => { await mutate("rule", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/quality-rules`, r), { success: "Rule added" }); }} />}
          </SectionCard>

          {/* Rules */}
          <SectionCard icon={<ListChecks />} title={`Rules (${rules.length})`} subtitle="Scored on the transformed data. On Databricks they run as Lakeflow expectations with quarantine / flag handling." bodyClassName="px-0 pb-2">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-[13px]">
                <thead className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <tr><th className="px-6 py-2">Rule</th><th className="px-2 py-2">Severity</th><th className="px-2 py-2">Pass rate</th><th className="px-2 py-2">RAG</th><th className="px-2 py-2 text-right">Issues</th><th className="px-2 py-2">On failure</th><th className="px-2 py-2">On</th><th className="px-6 py-2" /></tr>
                </thead>
                <tbody>
                  {rules.map((r) => {
                    const res = resultOf(r.id);
                    const o = ORIGIN[r.origin] ?? ORIGIN.user;
                    return (
                      <tr key={r.id} className={cn("border-t border-slate-200/50", !r.enabled && "opacity-50")}>
                        <td className="max-w-[380px] px-6 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5 font-semibold text-slate-900">{r.name || r.description}<Badge tone={o.tone}>{o.label}</Badge></div>
                          <div className="mt-0.5 truncate font-mono text-[11.5px] text-slate-500" title={res?.sql ?? ""}>{res?.status === "error" ? <span className="font-sans text-rose-600">{res.message}</span> : (res?.sql ?? `${r.column ?? ""} · ${humanize(r.rule)}`)}</div>
                        </td>
                        <td className="px-2 py-2.5"><Select className="w-28" value={r.severity} onChange={(v) => setRule(r.id, { severity: v })} options={SEVERITY_OPTS} /></td>
                        <td className="px-2 py-2.5">
                          {res?.pass_rate !== undefined ? (
                            <span className="flex items-center gap-2">
                              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200/70"><span className={cn("block h-full rounded-full", res.rag === "green" ? "bg-emerald-500" : res.rag === "amber" ? "bg-amber-400" : "bg-rose-500")} style={{ width: `${res.pass_rate}%` }} /></span>
                              <span className="w-12 tabular-nums text-slate-700">{res.pass_rate}%</span>
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-2 py-2.5"><RagPill rag={res?.rag} /></td>
                        <td className="px-2 py-2.5 text-right">
                          {res?.failed ? <button onClick={() => setFailures(res)} className="inline-flex items-center gap-1 font-semibold tabular-nums text-brand-600 hover:underline"><Eye className="size-3.5" />{fmtNumber(res.failed)}</button> : <span className="tabular-nums text-slate-400">0</span>}
                        </td>
                        <td className="px-2 py-2.5"><Select className="w-36" value={actionOf(r)} onChange={(v) => setRule(r.id, { on_fail: v })} options={ACTION_OPTS} /></td>
                        <td className="px-2 py-2.5"><Switch checked={r.enabled} onCheckedChange={(v) => setRule(r.id, { enabled: v })} tone="green" /></td>
                        <td className="whitespace-nowrap px-6 py-2.5 text-right">
                          <Tooltip content="SQL, PySpark & RAG thresholds"><Button variant="ghost" size="icon" aria-label="Rule details" onClick={() => setDetails(r)}><Code2 /></Button></Tooltip>
                          <Button variant="ghost" size="icon" aria-label="Delete rule" onClick={() => mutate("rule", () => api.del<Pipeline>(`/api/pipelines/${pipeline.id}/quality-rules/${r.id}`))}><Trash2 /></Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rules.length === 0 && <div className="px-6 py-10 text-center text-sm text-slate-500"><AIBadge className="mb-2" /><div>No rules yet — describe one above, upload an Excel file, or apply the AI recommendations.</div></div>}
            </div>
          </SectionCard>
        </>
      )}
      <FailuresDialog pipelineId={pipeline.id} rule={failures} onClose={() => setFailures(null)} />
      <RuleDetailsDialog key={details?.id} pipeline={pipeline} rule={details} result={details ? resultOf(details.id) : undefined} onClose={() => setDetails(null)}
        onSave={async (p) => { await setRule(details!.id, p); setDetails(null); void reload(); }} />
    </div>
  );
}
