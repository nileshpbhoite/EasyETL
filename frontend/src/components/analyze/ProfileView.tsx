"use client";

import { KeyRound, Lock, Search, ShieldAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Card, Input, Progress, Segmented } from "@/components/ui";
import type { ColumnProfile, Profile } from "@/lib/types";
import { cn, fmtNumber, humanize } from "@/lib/utils";

const SEMANTIC_TONE: Record<string, "brand" | "ai" | "green" | "amber" | "sky" | "slate" | "red"> = {
  identifier: "brand", email: "sky", phone: "sky", date: "amber", date_of_birth: "amber", timestamp: "amber", country: "green", currency: "green",
  decimal: "green", integer: "green", percentage: "green", boolean: "slate", category: "ai", nested: "ai", person_name: "sky", address: "sky",
};

function Completeness({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <Progress value={pct} tone={pct >= 98 ? "green" : pct >= 90 ? "amber" : "red"} className="h-1.5 w-16" />
      <span className="w-12 text-right text-xs tabular-nums text-slate-600">{pct.toFixed(1)}%</span>
    </div>
  );
}

function issuesOf(c: ColumnProfile): string[] {
  const out = [];
  if (c.invalid_count) out.push(`${fmtNumber(c.invalid_count)} invalid`);
  if ((c.pattern_count ?? 1) > 2 && ["phone", "date", "date_of_birth", "identifier"].includes(c.semantic_type)) out.push(`${c.pattern_count} formats`);
  if (c.case_variant_values) out.push(`${c.case_variant_values} case variants`);
  if (c.whitespace_issues) out.push(`${fmtNumber(c.whitespace_issues)} spacing`);
  if (c.negative_count && ["currency", "decimal"].includes(c.semantic_type)) out.push(`${c.negative_count} negative`);
  if (c.outlier_count) out.push(`${c.outlier_count} outliers`);
  return out;
}

export function ColumnDetail({ col, onClose }: { col: ColumnProfile; onClose: () => void }) {
  const numeric = col.histogram && col.min !== undefined;
  return (
    <Card className="animate-slide-up">
      <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-base font-semibold">{col.name}</span>
            <Badge tone={SEMANTIC_TONE[col.semantic_type] ?? "slate"}>{humanize(col.semantic_type)}</Badge>
            {col.pii && <Badge tone="red"><Lock /> {col.pii.label}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">Stored as {col.dtype.replace("String", "text")} · detected with {Math.round(col.semantic_confidence * 100)}% confidence</div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="size-4" /></button>
      </div>
      <div className="grid gap-5 p-5 lg:grid-cols-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {[
            ["Missing", `${col.null_pct}% (${fmtNumber(col.null_count)})`],
            ["Unique", col.unique_pct != null ? `${col.unique_pct}%` : "—"],
            ["Distinct", fmtNumber(col.distinct_count)],
            ["Cardinality", humanize(col.cardinality)],
            ...(col.min !== undefined ? [["Min", fmtNumber(col.min, 2)], ["Max", fmtNumber(col.max, 2)], ["Mean", fmtNumber(col.mean, 2)], ["Median", fmtNumber(col.median, 2)]] : []),
            ...(col.date_min ? [["Earliest", col.date_min], ["Latest", col.date_max]] : []),
            ...(col.min_length != null ? [["Length", `${col.min_length}–${col.max_length}`]] : []),
            ["Invalid", fmtNumber(col.invalid_count ?? 0)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-slate-400">{k}</dt>
              <dd className="font-medium tabular-nums text-slate-800">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="lg:col-span-2">
          {col.histogram && col.histogram.length > 1 ? (
            <>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{numeric ? "Value distribution" : "Records per year"}</div>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={col.histogram} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f5" />
                    <XAxis dataKey="bin" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={(v) => (numeric ? Intl.NumberFormat(undefined, { notation: "compact" }).format(v) : String(v))} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{ fill: "#eef2ff" }} contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(v) => [fmtNumber(Number(v)), "Records"]} labelFormatter={(l) => (numeric ? `≥ ${fmtNumber(Number(l), 2)}` : String(l))} />
                    <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : (
            <>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Most common values</div>
              <div className="space-y-1.5">
                {(col.top_values ?? []).slice(0, 7).map((t) => (
                  <div key={String(t.value)} className="flex items-center gap-2 text-sm">
                    <span className="w-44 truncate font-mono text-xs text-slate-700" title={String(t.value)}>{String(t.value)}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(2, t.pct)}%` }} />
                    </div>
                    <span className="w-14 text-right text-xs tabular-nums text-slate-500">{t.pct}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {col.patterns && col.patterns.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Formats detected ({col.pattern_count})</div>
                {col.patterns.slice(0, 5).map((p) => (
                  <div key={p.pattern} className="flex justify-between text-xs">
                    <code className="truncate text-slate-600">{p.pattern}</code>
                    <span className="text-slate-400">{p.pct}%</span>
                  </div>
                ))}
              </div>
            )}
            {col.invalid_examples && col.invalid_examples.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-rose-600">Invalid examples</div>
                <div className="flex flex-wrap gap-1">
                  {col.invalid_examples.map((e) => (
                    <code key={e} className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">{e}</code>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function ProfileView({ profile }: { profile: Profile }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "issues" | "pii">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const pk = profile.primary_key_candidates[0]?.column;
  const cols = useMemo(
    () => profile.columns.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) && (filter === "all" || (filter === "issues" ? issuesOf(c).length > 0 || c.null_pct > 1 : !!c.pii))),
    [profile, q, filter],
  );
  const sel = profile.columns.find((c) => c.name === selected);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a column" className="pl-9" />
        </div>
        <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: "all", label: `All (${profile.columns.length})` }, { value: "issues", label: "With issues" }, { value: "pii", label: `PII (${profile.pii_columns.length})` }]} />
        {profile.sampled && <Badge tone="sky">Profiled on a {fmtNumber(profile.profiled_rows)}-row sample of {fmtNumber(profile.row_count)}</Badge>}
      </div>
      {sel && <ColumnDetail col={sel} onClose={() => setSelected(null)} />}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5 font-medium">Column</th>
                <th className="px-3 py-2.5 font-medium">Detected type</th>
                <th className="px-3 py-2.5 font-medium">Completeness</th>
                <th className="px-3 py-2.5 text-right font-medium">Unique</th>
                <th className="px-3 py-2.5 font-medium">Sample values</th>
                <th className="px-4 py-2.5 font-medium">Findings</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => {
                const issues = issuesOf(c);
                return (
                  <tr key={c.name} onClick={() => setSelected(c.name === selected ? null : c.name)} className={cn("cursor-pointer border-b border-slate-50 transition-colors hover:bg-brand-50/40", selected === c.name && "bg-brand-50/60")}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 font-mono text-[13px] font-medium text-slate-800">
                        {c.name === pk && <KeyRound className="size-3.5 text-amber-500" aria-label="Primary key" />}
                        {c.pii && <ShieldAlert className="size-3.5 text-rose-500" aria-label="Personal data" />}
                        {c.name}
                      </div>
                    </td>
                    <td className="px-3 py-2.5"><Badge tone={SEMANTIC_TONE[c.semantic_type] ?? "slate"}>{humanize(c.semantic_type)}</Badge></td>
                    <td className="px-3 py-2.5"><Completeness pct={100 - c.null_pct} /></td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-600">{c.unique_pct != null ? `${c.unique_pct}%` : "—"}</td>
                    <td className="max-w-[240px] truncate px-3 py-2.5 font-mono text-xs text-slate-500">{c.is_nested ? (c.nested_fields ?? []).slice(0, 4).join(", ") : (c.sample_values ?? []).slice(0, 3).map(String).join(" · ")}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {issues.length === 0 && c.null_pct <= 1 ? <span className="text-xs text-emerald-600">✓ Clean</span> : issues.map((i) => <Badge key={i} tone="amber">{i}</Badge>)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
