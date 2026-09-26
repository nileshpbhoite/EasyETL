"use client";

import { Braces, Hash, Plus, Sigma, SquareFunction, Split, Trash2, Type } from "lucide-react";
import { Button, Input, Select } from "@/components/ui";
import type { ColumnInfo, TransformLibrary } from "@/lib/types";
import { cn } from "@/lib/utils";

export type ExprNode =
  | { type: "column"; name: string }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "op"; op: string; left: ExprNode; right: ExprNode }
  | { type: "func"; name: string; args: ExprNode[] }
  | { type: "if"; condition: ExprNode; then: ExprNode; else?: ExprNode }
  | { type: "not"; arg: ExprNode };

const OP_LABELS: Record<string, string> = { "+": "+ plus", "-": "− minus", "*": "× times", "/": "÷ divided by", "%": "mod", "==": "= equals", "!=": "≠ not equal", ">": "> greater than", "<": "< less than", ">=": "≥ at least", "<=": "≤ at most", and: "AND", or: "OR" };

export function describeExpr(n: ExprNode | undefined, fns?: TransformLibrary["functions"]): string {
  if (!n) return "…";
  switch (n.type) {
    case "column":
      return n.name || "[column]";
    case "literal":
      return typeof n.value === "string" ? `"${n.value}"` : String(n.value);
    case "op":
      return `(${describeExpr(n.left, fns)} ${n.op === "and" ? "AND" : n.op === "or" ? "OR" : n.op} ${describeExpr(n.right, fns)})`;
    case "func": {
      const label = fns?.find((f) => f.name === n.name)?.label ?? n.name;
      return `${label}(${n.args.map((a) => describeExpr(a, fns)).join(", ")})`;
    }
    case "if":
      return `IF ${describeExpr(n.condition, fns)} THEN ${describeExpr(n.then, fns)} ELSE ${describeExpr(n.else, fns)}`;
    case "not":
      return `NOT ${describeExpr(n.arg, fns)}`;
  }
}

function blank(kind: string, columns: ColumnInfo[]): ExprNode {
  const c = columns[0]?.name ?? "";
  if (kind === "column") return { type: "column", name: c };
  if (kind === "literal") return { type: "literal", value: "" };
  if (kind === "op") return { type: "op", op: "+", left: { type: "column", name: c }, right: { type: "literal", value: 1 } };
  if (kind === "func") return { type: "func", name: "upper", args: [{ type: "column", name: c }] };
  return { type: "if", condition: { type: "op", op: ">", left: { type: "column", name: c }, right: { type: "literal", value: 0 } }, then: { type: "literal", value: "Yes" }, else: { type: "literal", value: "No" } };
}

const KINDS = [
  { value: "column", label: "Column", icon: Braces },
  { value: "literal", label: "Value", icon: Type },
  { value: "op", label: "Math / Compare", icon: Sigma },
  { value: "func", label: "Function", icon: SquareFunction },
  { value: "if", label: "IF / ELSE", icon: Split },
];

function NodeEditor({ node, onChange, columns, lib, depth }: { node: ExprNode; onChange: (n: ExprNode) => void; columns: ColumnInfo[]; lib: TransformLibrary; depth: number }) {
  const kindPicker = (
    <div className="flex gap-0.5">
      {KINDS.map((k) => (
        <button
          key={k.value}
          type="button"
          title={k.label}
          onClick={() => node.type !== k.value && onChange(blank(k.value, columns))}
          className={cn("flex size-6 items-center justify-center rounded", node.type === k.value ? "bg-ai-600 text-white" : "text-slate-400 hover:bg-slate-100 hover:text-slate-600")}
        >
          <k.icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
  const shell = (children: React.ReactNode) => (
    <div className={cn("space-y-2 rounded-lg border p-2", depth % 2 === 0 ? "border-ai-200 bg-ai-50/40" : "border-slate-200 bg-white")}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{KINDS.find((k) => k.value === node.type)?.label}</span>
        {kindPicker}
      </div>
      {children}
    </div>
  );
  if (node.type === "column")
    return shell(<Select value={node.name} onChange={(v) => onChange({ type: "column", name: v })} options={columns.map((c) => ({ value: c.name, label: `${c.name} (${c.kind})` }))} />);
  if (node.type === "literal")
    return shell(
      <Input
        value={node.value === null ? "" : String(node.value)}
        onChange={(e) => {
          const raw = e.target.value;
          const num = raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
          onChange({ type: "literal", value: num });
        }}
        placeholder="Type a number or text"
      />,
    );
  if (node.type === "op")
    return shell(
      <div className="space-y-2">
        <NodeEditor node={node.left} onChange={(l) => onChange({ ...node, left: l })} columns={columns} lib={lib} depth={depth + 1} />
        <Select value={node.op} onChange={(op) => onChange({ ...node, op })} options={Object.entries(OP_LABELS).map(([value, label]) => ({ value, label }))} />
        <NodeEditor node={node.right} onChange={(r) => onChange({ ...node, right: r })} columns={columns} lib={lib} depth={depth + 1} />
      </div>,
    );
  if (node.type === "func") {
    const spec = lib.functions.find((f) => f.name === node.name);
    const setFn = (name: string) => {
      const s = lib.functions.find((f) => f.name === name);
      const n = s && s.args >= 0 ? s.args : Math.max(2, node.args.length);
      const args = Array.from({ length: n }, (_, i) => node.args[i] ?? blank(i === 0 ? "column" : "literal", columns));
      onChange({ type: "func", name, args });
    };
    const groups = Array.from(new Set(lib.functions.map((f) => f.group)));
    return shell(
      <div className="space-y-2">
        <select value={node.name} onChange={(e) => setFn(e.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm">
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {lib.functions.filter((f) => f.group === g).map((f) => (
                <option key={f.name} value={f.name}>{f.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {node.args.map((a, i) => (
          <div key={i} className="flex gap-1">
            <div className="flex-1"><NodeEditor node={a} onChange={(n) => onChange({ ...node, args: node.args.map((x, j) => (j === i ? n : x)) })} columns={columns} lib={lib} depth={depth + 1} /></div>
            {spec?.args === -1 && node.args.length > 1 && (
              <Button variant="ghost" size="icon" onClick={() => onChange({ ...node, args: node.args.filter((_, j) => j !== i) })} aria-label="Remove input"><Trash2 /></Button>
            )}
          </div>
        ))}
        {spec?.args === -1 && <Button size="sm" variant="ghost" onClick={() => onChange({ ...node, args: [...node.args, blank("column", columns)] })}><Plus /> Add input</Button>}
      </div>,
    );
  }
  if (node.type === "if")
    return shell(
      <div className="space-y-2">
        <div className="text-xs font-semibold text-ai-700">IF</div>
        <NodeEditor node={node.condition} onChange={(c) => onChange({ ...node, condition: c })} columns={columns} lib={lib} depth={depth + 1} />
        <div className="text-xs font-semibold text-ai-700">THEN</div>
        <NodeEditor node={node.then} onChange={(t) => onChange({ ...node, then: t })} columns={columns} lib={lib} depth={depth + 1} />
        <div className="text-xs font-semibold text-ai-700">ELSE</div>
        <NodeEditor node={node.else ?? { type: "literal", value: null }} onChange={(e) => onChange({ ...node, else: e })} columns={columns} lib={lib} depth={depth + 1} />
      </div>,
    );
  return shell(<div className="text-xs text-slate-500">Unsupported block</div>);
}

export function ExpressionBuilder({ value, onChange, columns, lib }: { value: ExprNode | undefined; onChange: (n: ExprNode) => void; columns: ColumnInfo[]; lib: TransformLibrary }) {
  const c = columns[0]?.name ?? "";
  const dateCol = columns.find((x) => x.kind === "date")?.name ?? c;
  const numCol = columns.find((x) => x.kind === "numeric")?.name ?? c;
  const starters: { label: string; node: ExprNode }[] = [
    { label: "A + B", node: { type: "op", op: "+", left: { type: "column", name: numCol }, right: { type: "literal", value: 0 } } },
    { label: "IF … THEN … ELSE", node: blank("if", columns) },
    { label: "Age from a date", node: { type: "func", name: "years_between", args: [{ type: "column", name: dateCol }, { type: "func", name: "today", args: [] }] } },
    { label: "Combine text", node: { type: "func", name: "concat", args: [{ type: "column", name: c }, { type: "literal", value: " " }, { type: "column", name: columns[1]?.name ?? c }] } },
  ];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {starters.map((s) => (
          <button key={s.label} type="button" onClick={() => onChange(s.node)} className="rounded-full border border-ai-200 bg-white px-2 py-0.5 text-[11px] text-ai-700 hover:bg-ai-50">
            <Hash className="mr-0.5 inline size-3" />{s.label}
          </button>
        ))}
      </div>
      <NodeEditor node={value ?? blank("op", columns)} onChange={onChange} columns={columns} lib={lib} depth={0} />
      <div className="rounded-lg bg-brand-50 px-3 py-2 font-mono text-[11px] text-brand-800 ring-1 ring-brand-100">= {describeExpr(value, lib.functions)}</div>
    </div>
  );
}
