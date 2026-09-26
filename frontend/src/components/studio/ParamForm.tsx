"use client";

import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Checkbox, Field, Input, KeyValueEditor, Segmented, Select, Switch } from "@/components/ui";
import type { ColumnInfo, ParamSpec, TransformLibrary, TransformSpec } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ExpressionBuilder, type ExprNode } from "./ExpressionBuilder";

type Params = Record<string, any>;

const OPS = [
  { value: "equals", label: "equals" }, { value: "not_equals", label: "does not equal" }, { value: "gt", label: "greater than" }, { value: "gte", label: "at least" },
  { value: "lt", label: "less than" }, { value: "lte", label: "at most" }, { value: "between", label: "between" }, { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" }, { value: "starts_with", label: "starts with" }, { value: "ends_with", label: "ends with" },
  { value: "in_list", label: "is one of" }, { value: "not_in_list", label: "is not one of" }, { value: "is_null", label: "is empty" }, { value: "is_not_null", label: "is not empty" },
];
const AGG_FNS = [
  { value: "count", label: "Count" }, { value: "count_distinct", label: "Distinct count" }, { value: "sum", label: "Sum" }, { value: "mean", label: "Average" },
  { value: "min", label: "Min" }, { value: "max", label: "Max" }, { value: "median", label: "Median" }, { value: "p90", label: "90th percentile" },
  { value: "p95", label: "95th percentile" }, { value: "std", label: "Std deviation" }, { value: "first", label: "First" }, { value: "last", label: "Last" },
];
const TYPES = [
  { value: "string", label: "Text" }, { value: "integer", label: "Whole number" }, { value: "decimal", label: "Decimal" }, { value: "boolean", label: "True / False" },
  { value: "date", label: "Date" }, { value: "timestamp", label: "Date & time" }, { value: "currency", label: "Currency" }, { value: "percentage", label: "Percentage" },
];

function filterCols(columns: ColumnInfo[], kind: ParamSpec["column_kind"]) {
  if (kind === "any") return columns;
  const f = columns.filter((c) => c.kind === kind || (kind === "text" && c.kind !== "nested"));
  return f.length ? f : columns;
}

export function ColumnMulti({ value, onChange, columns }: { value: string[]; onChange: (v: string[]) => void; columns: ColumnInfo[] }) {
  const [open, setOpen] = useState(false);
  const selected = value ?? [];
  return (
    <div className="relative">
      <div onClick={() => setOpen((v) => !v)} className="flex min-h-9 cursor-pointer flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 shadow-sm hover:border-slate-300">
        {selected.length === 0 && <span className="px-1 text-sm text-slate-400">Choose columns…</span>}
        {selected.map((c) => (
          <span key={c} className="flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700">
            {c}
            <button type="button" onClick={(e) => { e.stopPropagation(); onChange(selected.filter((x) => x !== c)); }} aria-label={`Remove ${c}`}><X className="size-3" /></button>
          </span>
        ))}
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lift scrollbar-thin">
            <button type="button" className="w-full rounded px-2 py-1 text-left text-xs text-brand-600 hover:bg-slate-50" onClick={() => onChange(selected.length === columns.length ? [] : columns.map((c) => c.name))}>
              {selected.length === columns.length ? "Clear all" : "Select all"}
            </button>
            {columns.map((c) => (
              <label key={c.name} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                <Checkbox checked={selected.includes(c.name)} onChange={(v) => onChange(v ? [...selected, c.name] : selected.filter((x) => x !== c.name))} />
                <span className="truncate font-mono text-xs">{c.name}</span>
                <span className="ml-auto text-[10px] text-slate-400">{c.kind}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ListEditor({ items, onChange, render, blank, addLabel }: { items: any[]; onChange: (v: any[]) => void; render: (item: any, set: (v: any) => void, i: number) => React.ReactNode; blank: () => any; addLabel: string }) {
  const list = items ?? [];
  return (
    <div className="space-y-2">
      {list.map((it, i) => (
        <div key={i} className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50/60 p-2">
          <div className="min-w-0 flex-1">{render(it, (v) => onChange(list.map((x, j) => (j === i ? v : x))), i)}</div>
          <Button variant="ghost" size="icon" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 /></Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...list, blank()])}><Plus /> {addLabel}</Button>
    </div>
  );
}

export function ConditionBuilder({ value, onChange, columns, logic, onLogic }: { value: any[]; onChange: (v: any[]) => void; columns: ColumnInfo[]; logic?: string; onLogic?: (v: string) => void }) {
  return (
    <div className="space-y-2">
      {onLogic && (value?.length ?? 0) > 1 && <Segmented size="sm" value={logic ?? "and"} onChange={onLogic} options={[{ value: "and", label: "Match ALL (AND)" }, { value: "or", label: "Match ANY (OR)" }]} />}
      <ListEditor
        items={value}
        onChange={onChange}
        addLabel="Add condition"
        blank={() => ({ column: columns[0]?.name, op: "equals", value: "" })}
        render={(c, set) => (
          <div className="grid grid-cols-2 gap-1.5">
            <Select value={c.column} onChange={(v) => set({ ...c, column: v })} options={columns.map((x) => ({ value: x.name, label: x.name }))} />
            <Select value={c.op} onChange={(v) => set({ ...c, op: v })} options={OPS} />
            {!["is_null", "is_not_null"].includes(c.op) && <Input value={c.value ?? ""} onChange={(e) => set({ ...c, value: e.target.value })} placeholder={c.op.includes("list") ? "a, b, c" : "value"} className={c.op === "between" ? "" : "col-span-2"} />}
            {c.op === "between" && <Input value={c.value2 ?? ""} onChange={(e) => set({ ...c, value2: e.target.value })} placeholder="and" />}
          </div>
        )}
      />
    </div>
  );
}

export function ParamField({ spec, value, onChange, params, setParams, columns, rightColumns, datasets, lib, currentDataset }: {
  spec: ParamSpec;
  value: any;
  onChange: (v: any) => void;
  params: Params;
  setParams: (p: Params) => void;
  columns: ColumnInfo[];
  rightColumns: ColumnInfo[];
  datasets: { id: string; name: string }[];
  lib: TransformLibrary;
  currentDataset: string;
}) {
  const otherSide = ["right_on"].includes(spec.name) || (spec.name === "columns" && !!params.right_dataset);
  const cols = filterCols(otherSide ? rightColumns : columns, spec.column_kind);
  switch (spec.type) {
    case "column":
      return <Select value={value ?? ""} onChange={onChange} placeholder={spec.required ? "Choose a column" : "— none —"} options={cols.map((c) => ({ value: c.name, label: c.name }))} />;
    case "columns":
      if (spec.options.length) return <ColumnMulti value={value ?? spec.default ?? []} onChange={onChange} columns={spec.options.map((o) => ({ name: o.value, type: "", kind: "text" }))} />;
      return <ColumnMulti value={value ?? []} onChange={onChange} columns={cols} />;
    case "text":
      return <Input value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={spec.placeholder ?? (spec.default != null ? String(spec.default) : "")} />;
    case "number":
      return <Input type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} placeholder={spec.default != null ? String(spec.default) : ""} />;
    case "boolean":
      return <Switch checked={value ?? spec.default ?? false} onCheckedChange={onChange} />;
    case "select":
      return (
        <div className="space-y-1.5">
          <Select value={value ?? spec.default ?? ""} onChange={onChange} options={spec.options} />
          {spec.name === "pattern" && <Input value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder="…or type a custom pattern" className="font-mono text-xs" />}
        </div>
      );
    case "mapping":
      return <KeyValueEditor value={value ?? {}} onChange={onChange} keyPlaceholder="When value is" valuePlaceholder="Replace with" />;
    case "rename_map":
      return (
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin">
          {columns.map((c) => (
            <div key={c.name} className="flex items-center gap-2">
              <span className="w-32 truncate font-mono text-xs text-slate-500">{c.name}</span>
              <span className="text-slate-300">→</span>
              <Input value={(value ?? {})[c.name] ?? ""} onChange={(e) => onChange({ ...(value ?? {}), [c.name]: e.target.value })} placeholder={c.name} className="h-8 text-xs" />
            </div>
          ))}
        </div>
      );
    case "conditions":
      return <ConditionBuilder value={value ?? []} onChange={onChange} columns={columns} logic={params.logic} onLogic={(l) => setParams({ ...params, logic: l })} />;
    case "sort_keys":
      return (
        <ListEditor items={value ?? []} onChange={onChange} addLabel="Add sort column" blank={() => ({ column: columns[0]?.name, descending: false })}
          render={(k, set) => (
            <div className="flex gap-1.5">
              <Select className="flex-1" value={k.column} onChange={(v) => set({ ...k, column: v })} options={columns.map((c) => ({ value: c.name, label: c.name }))} />
              <Segmented size="sm" value={k.descending ? "desc" : "asc"} onChange={(v) => set({ ...k, descending: v === "desc" })} options={[{ value: "asc", label: "A→Z" }, { value: "desc", label: "Z→A" }]} />
            </div>
          )} />
      );
    case "aggregations":
      return (
        <ListEditor items={value ?? []} onChange={onChange} addLabel="Add calculation" blank={() => ({ fn: "count" })}
          render={(a, set) => (
            <div className="grid grid-cols-2 gap-1.5">
              <Select value={a.fn} onChange={(v) => set({ ...a, fn: v })} options={AGG_FNS} />
              <Select value={a.column ?? ""} onChange={(v) => set({ ...a, column: v || undefined })} placeholder={a.fn === "count" ? "all records" : "column"} options={columns.map((c) => ({ value: c.name, label: c.name }))} />
              <Input className="col-span-2" value={a.alias ?? ""} onChange={(e) => set({ ...a, alias: e.target.value })} placeholder="Result column name (optional)" />
            </div>
          )} />
      );
    case "column_types":
      return (
        <ListEditor items={value ?? []} onChange={onChange} addLabel="Add conversion" blank={() => ({ column: columns[0]?.name, to: "decimal" })}
          render={(c, set) => (
            <div className="flex items-center gap-1.5">
              <Select className="flex-1" value={c.column} onChange={(v) => set({ ...c, column: v })} options={columns.map((x) => ({ value: x.name, label: x.name }))} />
              <span className="text-xs text-slate-400">→</span>
              <Select className="w-36" value={c.to} onChange={(v) => set({ ...c, to: v })} options={TYPES} />
            </div>
          )} />
      );
    case "case_rules":
      return (
        <ListEditor items={value ?? []} onChange={onChange} addLabel="Add rule" blank={() => ({ conditions: [{ column: columns[0]?.name, op: "equals", value: "" }], logic: "and", value: "" })}
          render={(r, set, i) => (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-ai-700">{i === 0 ? "IF" : "ELSE IF"}</div>
              <ConditionBuilder value={r.conditions} onChange={(c) => set({ ...r, conditions: c })} columns={columns} logic={r.logic} onLogic={(l) => set({ ...r, logic: l })} />
              <div className="flex items-center gap-2"><span className="text-xs font-semibold text-ai-700">THEN</span><Input value={r.value ?? ""} onChange={(e) => set({ ...r, value: e.target.value })} placeholder="value" /></div>
            </div>
          )} />
      );
    case "bins":
      return (
        <ListEditor items={value ?? []} onChange={onChange} addLabel="Add band" blank={() => ({ label: "", min: "", max: "" })}
          render={(b, set) => (
            <div className="grid grid-cols-3 gap-1.5">
              <Input value={b.label} onChange={(e) => set({ ...b, label: e.target.value })} placeholder="Label" />
              <Input type="number" value={b.min ?? ""} onChange={(e) => set({ ...b, min: e.target.value })} placeholder="From" />
              <Input type="number" value={b.max ?? ""} onChange={(e) => set({ ...b, max: e.target.value })} placeholder="Up to" />
            </div>
          )} />
      );
    case "schema_map":
      return (
        <ListEditor items={value ?? []} onChange={onChange} addLabel="Add mapping" blank={() => ({ source: columns[0]?.name, target: "", type: "" })}
          render={(m, set) => (
            <div className="grid grid-cols-3 gap-1.5">
              <Select value={m.source} onChange={(v) => set({ ...m, source: v })} options={columns.map((c) => ({ value: c.name, label: c.name }))} />
              <Input value={m.target} onChange={(e) => set({ ...m, target: e.target.value })} placeholder="Target name" />
              <Select value={m.type ?? ""} onChange={(v) => set({ ...m, type: v || undefined })} placeholder="Keep type" options={TYPES} />
            </div>
          )} />
      );
    case "survivorship":
      return (
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin">
          {columns.filter((c) => !(params.columns ?? []).includes(c.name)).map((c) => (
            <div key={c.name} className="flex items-center gap-2">
              <span className="w-32 truncate font-mono text-xs text-slate-500">{c.name}</span>
              <Select className="flex-1" value={(value ?? {})[c.name] ?? "first_non_null"} onChange={(v) => onChange({ ...(value ?? {}), [c.name]: v })}
                options={[{ value: "first_non_null", label: "First non-empty" }, { value: "most_common", label: "Most common" }, { value: "longest", label: "Longest / most complete" }, { value: "max", label: "Highest" }, { value: "min", label: "Lowest" }]} />
            </div>
          ))}
        </div>
      );
    case "column_order": {
      const order: string[] = value?.length ? value : columns.map((c) => c.name);
      const move = (i: number, d: number) => {
        const next = [...order];
        const [x] = next.splice(i, 1);
        next.splice(i + d, 0, x);
        onChange(next);
      };
      return (
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
          {order.map((c, i) => (
            <div key={c} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1">
              <GripVertical className="size-3.5 text-slate-300" />
              <span className="flex-1 truncate font-mono text-xs">{c}</span>
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="text-slate-400 hover:text-slate-700 disabled:opacity-30" aria-label="Move up"><ArrowUp className="size-3.5" /></button>
              <button type="button" disabled={i === order.length - 1} onClick={() => move(i, 1)} className="text-slate-400 hover:text-slate-700 disabled:opacity-30" aria-label="Move down"><ArrowDown className="size-3.5" /></button>
            </div>
          ))}
        </div>
      );
    }
    case "expression":
      return <ExpressionBuilder value={value as ExprNode} onChange={onChange} columns={columns} lib={lib} />;
    case "dataset":
      return <Select value={value ?? ""} onChange={onChange} placeholder="Choose dataset" options={datasets.filter((d) => d.id !== currentDataset).map((d) => ({ value: d.id, label: d.name }))} />;
    case "datasets":
      return (
        <div className="space-y-1">
          {datasets.filter((d) => d.id !== currentDataset).map((d) => (
            <label key={d.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={(value ?? []).includes(d.id)} onChange={(v) => onChange(v ? [...(value ?? []), d.id] : (value ?? []).filter((x: string) => x !== d.id))} /> {d.name}
            </label>
          ))}
        </div>
      );
    default:
      return <Input value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function ParamForm({ spec, params, setParams, columns, rightColumns, datasets, lib, currentDataset, advanced }: {
  spec: TransformSpec;
  params: Params;
  setParams: (p: Params) => void;
  columns: ColumnInfo[];
  rightColumns: ColumnInfo[];
  datasets: { id: string; name: string }[];
  lib: TransformLibrary;
  currentDataset: string;
  advanced: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(advanced);
  const fields = spec.params.filter((p) => !p.advanced || showAdvanced);
  const hasAdvanced = spec.params.some((p) => p.advanced);
  return (
    <div className="space-y-4">
      {fields.map((p) => (
        <Field key={p.name} label={p.label} required={p.required} help={p.help}>
          <ParamField spec={p} value={params[p.name]} onChange={(v) => setParams({ ...params, [p.name]: v })} params={params} setParams={setParams} columns={columns}
            rightColumns={rightColumns} datasets={datasets} lib={lib} currentDataset={currentDataset} />
        </Field>
      ))}
      {spec.params.length === 0 && <div className="text-sm text-slate-500">No settings needed — this step works automatically.</div>}
      {hasAdvanced && (
        <button type="button" onClick={() => setShowAdvanced((v) => !v)} className={cn("text-xs font-medium text-brand-600 hover:underline")}>
          {showAdvanced ? "Hide" : "Show"} advanced options
        </button>
      )}
      {spec.destructive && <Badge tone="amber">This step removes data from Silver — Bronze keeps the original.</Badge>}
    </div>
  );
}
