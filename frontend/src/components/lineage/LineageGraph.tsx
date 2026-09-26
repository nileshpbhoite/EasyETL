"use client";

import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Database, FileText, LayoutDashboard, Table2, Wand } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
  const box = useRef<HTMLDivElement>(null);
  const { nodes, edges, width } = useMemo(() => {
    // Layout: one vertical lane per dataset (raw → bronze → transformations → silver),
    // gold models in a row underneath, dashboards below their gold table.
    const out: Record<string, string[]> = {};
    data.edges.forEach((e) => (out[e.source] = [...(out[e.source] ?? []), e.target]));
    const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
    const pos: Record<string, { x: number; y: number }> = {};
    const COL = 215, ROW = 64;
    const raws = data.nodes.filter((n) => n.type === "raw");
    let maxDepth = 1;
    raws.forEach((r, lane) => {
      let cur: string | undefined = r.id;
      let depth = 1;
      while (cur && !pos[cur]) {
        pos[cur] = { x: lane * COL, y: depth * ROW };
        maxDepth = Math.max(maxDepth, depth);
        const next: string | undefined = (out[cur] ?? []).find((t) => ["bronze", "transformation", "silver"].includes(byId[t]?.type));
        cur = next;
        depth++;
      }
    });
    const lanes = Math.max(raws.length, 1);
    const golds = data.nodes.filter((n) => n.type === "gold");
    golds.forEach((g, i) => {
      const x = golds.length === 1 ? ((lanes - 1) * COL) / 2 : (i * (lanes - 1) * COL) / Math.max(golds.length - 1, 1);
      pos[g.id] = { x, y: (maxDepth + 1.4) * ROW };
      (out[g.id] ?? []).forEach((d) => (pos[d] = { x, y: (maxDepth + 2.6) * ROW }));
    });
    data.nodes.filter((n) => n.type === "source").forEach((n) => (pos[n.id] = { x: ((lanes - 1) * COL) / 2, y: 0 }));
    let extra = 0;
    data.nodes.forEach((n) => { if (!pos[n.id]) pos[n.id] = { x: (lanes + extra++) * COL, y: ROW }; });
    const nodes: Node[] = data.nodes.map((n) => ({ id: n.id, type: "l", position: pos[n.id], data: { label: n.label, kind: n.type, selected: sel === n.id } }));
    const edges: Edge[] = data.edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target, style: { stroke: "#c0d4fe", strokeWidth: 1.5 }, animated: sel !== null && (e.source === sel || e.target === sel) }));
    return { nodes, edges, width: lanes * COL };
  }, [data, sel]);
  const selected = data.nodes.find((n) => n.id === sel);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div ref={box} className="grid-bg overflow-hidden rounded-xl border border-slate-200" style={{ height }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={(inst) => {
            const w = box.current?.clientWidth ?? 800;
            const zoom = Math.min(1, Math.max(0.55, (w - 40) / (width + 20)));
            inst.setViewport({ x: Math.max(10, (w - width * zoom) / 2), y: 16, zoom });
          }}
          panOnScroll
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, n) => setSel(n.id)}
          proOptions={{ hideAttribution: true }}
        >
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
