"use client";

import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Database, FileText, LayoutDashboard, Table2, Wand } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Card } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface LineageData {
  nodes: { id: string; type: string; label: string; meta: Record<string, any> }[];
  edges: { source: string; target: string }[];
}

const STYLE: Record<string, { color: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  source: { color: "#0c1330", icon: Database, label: "Source" },
  raw: { color: "#64748b", icon: FileText, label: "Raw" },
  bronze: { color: "#b45309", icon: Table2, label: "Bronze" },
  transformation: { color: "#7c3aed", icon: Wand, label: "Transformation" },
  silver: { color: "#475569", icon: Table2, label: "Silver" },
  gold: { color: "#b7791f", icon: Table2, label: "Gold" },
  dashboard: { color: "#0ea5e9", icon: LayoutDashboard, label: "Dashboard" },
};
const ORDER = ["source", "raw", "bronze", "transformation", "silver", "gold", "dashboard"];

function LNode({ data }: NodeProps<Node<{ label: string; kind: string; selected: boolean }>>) {
  const s = STYLE[data.kind] ?? STYLE.raw;
  return (
    <div className={cn("w-[190px] rounded-lg border bg-white px-2.5 py-2 shadow-card", data.selected ? "border-brand-500 ring-2 ring-brand-200" : "border-slate-200")}>
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2">
        <div className="flex size-6 shrink-0 items-center justify-center rounded text-white" style={{ background: s.color }}><s.icon className="size-3.5" /></div>
        <div className="min-w-0">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{s.label}</div>
          <div className="truncate text-[11.5px] font-medium text-slate-800" title={data.label}>{data.label}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const nodeTypes = { l: LNode };

export function LineageGraph({ data, height = 620, focus }: { data: LineageData; height?: number; focus?: string }) {
  const [sel, setSel] = useState<string | null>(focus ?? null);
  const { nodes, edges } = useMemo(() => {
    // Layered layout: each transformation chain is stacked vertically under its bronze table.
    const depth: Record<string, number> = {};
    const incoming: Record<string, string[]> = {};
    data.edges.forEach((e) => (incoming[e.target] = [...(incoming[e.target] ?? []), e.source]));
    const d = (id: string, seen = new Set<string>()): number => {
      if (depth[id] !== undefined) return depth[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      const parents = incoming[id] ?? [];
      depth[id] = parents.length ? Math.max(...parents.map((p) => d(p, seen))) + 1 : 0;
      return depth[id];
    };
    data.nodes.forEach((n) => d(n.id));
    const cols: Record<number, number> = {};
    const lane: Record<string, number> = {};
    // assign horizontal lane by dataset chain for readability
    const laneOf = (id: string): number => {
      if (lane[id] !== undefined) return lane[id];
      const parents = incoming[id] ?? [];
      const n = data.nodes.find((x) => x.id === id);
      if (n?.type === "raw" || !parents.length || n?.type === "gold" || n?.type === "dashboard") {
        const dep = depth[id];
        lane[id] = cols[dep] = (cols[dep] ?? -1) + 1;
        return lane[id];
      }
      lane[id] = laneOf(parents[0]);
      return lane[id];
    };
    const nodes: Node[] = data.nodes
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
      .map((n) => ({ id: n.id, type: "l", position: { x: laneOf(n.id) * 215, y: depth[n.id] * 78 }, data: { label: n.label, kind: n.type, selected: sel === n.id } }));
    const edges: Edge[] = data.edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target, style: { stroke: "#c7d2fe", strokeWidth: 1.5 }, animated: sel !== null && (e.source === sel || e.target === sel) }));
    return { nodes, edges };
  }, [data, sel]);
  const selected = data.nodes.find((n) => n.id === sel);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid-bg overflow-hidden rounded-xl border border-slate-200" style={{ height }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, n) => setSel(n.id)} proOptions={{ hideAttribution: true }}>
          <Background gap={18} color="#e2e8f0" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <Card className="h-fit p-5">
        {selected ? (
          <div className="space-y-3 animate-fade-in">
            <Badge tone="brand">{STYLE[selected.type]?.label}</Badge>
            <div className="break-words font-semibold text-slate-900">{selected.label}</div>
            {selected.meta.description && <div className="text-sm text-slate-600">{selected.meta.description}</div>}
            <dl className="space-y-2 text-sm">
              {Object.entries(selected.meta).filter(([k, v]) => k !== "description" && v !== null && v !== undefined && typeof v !== "object").map(([k, v]) => (
                <div key={k}><dt className="text-xs capitalize text-slate-400">{k.replace(/_/g, " ")}</dt><dd className="break-words font-mono text-xs text-slate-700">{String(v)}</dd></div>
              ))}
              {Object.entries(selected.meta).filter(([, v]) => v && typeof v === "object").map(([k, v]) => (
                <div key={k}><dt className="text-xs capitalize text-slate-400">{k.replace(/_/g, " ")}</dt><dd><pre className="max-h-40 overflow-auto rounded bg-slate-50 p-2 font-mono text-[10.5px] text-slate-600">{JSON.stringify(v, null, 1)}</pre></dd></div>
              ))}
            </dl>
          </div>
        ) : (
          <div className="text-sm text-slate-500">Click any node to see its metadata and transformation history.</div>
        )}
      </Card>
    </div>
  );
}
