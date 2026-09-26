"use client";

import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Database, KeyRound, LayoutDashboard, Table2 } from "lucide-react";
import type { PipelineMetadata, TableDesign } from "@/lib/types";
import { cn } from "@/lib/utils";

const LAYER = {
  source: { title: "Source", color: "#0c1330", bg: "bg-slate-50", ring: "ring-slate-200" },
  bronze: { title: "Bronze · raw", color: "#b45309", bg: "bg-orange-50", ring: "ring-orange-200" },
  silver: { title: "Silver · clean", color: "#475569", bg: "bg-slate-50", ring: "ring-slate-300" },
  gold: { title: "Gold · business", color: "#b7791f", bg: "bg-amber-50", ring: "ring-amber-200" },
  bi: { title: "Consumers", color: "#7c3aed", bg: "bg-ai-50", ring: "ring-ai-200" },
};

type D = { layer: keyof typeof LAYER; label: string; sub?: string; pk?: string[]; onClick?: () => void; selected?: boolean };

function TableNode({ data }: NodeProps<Node<D>>) {
  const L = LAYER[data.layer];
  const Icon = data.layer === "source" ? Database : data.layer === "bi" ? LayoutDashboard : Table2;
  return (
    <div onClick={data.onClick} className={cn("w-[210px] cursor-pointer rounded-lg bg-white px-3 py-2 shadow-card ring-1 transition-all hover:shadow-lift", L.ring, data.selected && "ring-2 ring-brand-500")}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0" style={{ color: L.color }} />
        <span className="truncate font-mono text-[11.5px] font-semibold text-slate-800">{data.label}</span>
      </div>
      {data.sub && <div className="mt-0.5 truncate text-[10.5px] text-slate-500">{data.sub}</div>}
      {data.pk && data.pk.length > 0 && <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-700"><KeyRound className="size-3" /> {data.pk.join(", ")}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function LaneNode({ data }: NodeProps<Node<{ title: string; color: string; height: number }>>) {
  return (
    <div className="pointer-events-none w-[240px] rounded-xl border border-dashed border-slate-200 bg-white/40" style={{ height: data.height }}>
      <div className="px-3 pt-2 text-[10px] font-bold uppercase tracking-widest" style={{ color: data.color }}>{data.title}</div>
    </div>
  );
}

const nodeTypes = { table: TableNode, lane: LaneNode };

export function Architecture({ meta, onSelect, selected, height = 460 }: { meta: PipelineMetadata; onSelect?: (t: TableDesign | null) => void; selected?: string | null; height?: number }) {
  const lh = meta.lakehouse;
  const datasets = meta.source.datasets.filter((d) => d.selected);
  const tables = lh.tables.filter((t) => t.enabled);
  const cols: (keyof typeof LAYER)[] = ["source", "bronze", "silver", "gold", "bi"];
  const rowsPer: Record<string, number> = { source: datasets.length, bronze: 0, silver: 0, gold: 0, bi: 0 };
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const x = (l: keyof typeof LAYER) => cols.indexOf(l) * 260;
  const place = (layer: keyof typeof LAYER) => {
    const i = rowsPer[`_${layer}`] ?? 0;
    rowsPer[`_${layer}`] = i + 1;
    return 36 + i * 74;
  };
  datasets.forEach((d) => nodes.push({ id: `src:${d.id}`, type: "table", position: { x: x("source") + 15, y: place("source") }, data: { layer: "source", label: d.name.split(" › ").pop(), sub: `${d.row_count?.toLocaleString() ?? "?"} records` } }));
  for (const layer of ["bronze", "silver", "gold"] as const) {
    tables.filter((t) => t.layer === layer).forEach((t) => {
      nodes.push({ id: `t:${t.name}`, type: "table", position: { x: x(layer) + 15, y: place(layer) }, data: { layer, label: t.name, sub: t.business_entity ?? t.description, pk: t.primary_key, onClick: () => onSelect?.(t), selected: selected === t.id } });
      if (layer === "bronze") t.source_datasets.forEach((ds) => edges.push({ id: `e-${ds}-${t.name}`, source: `src:${ds}`, target: `t:${t.name}` }));
      else t.source_tables.forEach((st) => edges.push({ id: `e-${st}-${t.name}`, source: `t:${st}`, target: `t:${t.name}` }));
    });
  }
  tables.filter((t) => t.layer === "gold").forEach((t) => {
    const id = `bi:${t.name}`;
    nodes.push({ id, type: "table", position: { x: x("bi") + 15, y: place("bi") }, data: { layer: "bi", label: `${t.name.replace(/_/g, " ")}`, sub: "Dashboards · Genie · ML" } });
    edges.push({ id: `e-${t.name}-bi`, source: `t:${t.name}`, target: id });
  });
  const maxRows = Math.max(...cols.map((c) => rowsPer[`_${c}`] ?? 0), 1);
  const laneH = 50 + maxRows * 74;
  const lanes: Node[] = cols.map((c) => ({ id: `lane:${c}`, type: "lane", position: { x: x(c), y: 0 }, data: { title: LAYER[c].title, color: LAYER[c].color, height: laneH }, draggable: false, selectable: false, zIndex: -1 }));
  return (
    <div className="grid-bg overflow-hidden rounded-xl border border-slate-200" style={{ height: Math.min(height, laneH + 150) }}>
      <ReactFlow
        nodes={[...lanes, ...nodes]}
        edges={edges.map((e) => ({ ...e, animated: true, style: { stroke: "#a5b4fc", strokeWidth: 1.5 } }))}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onPaneClick={() => onSelect?.(null)}
      >
        <Background gap={18} color="#e2e8f0" />
      </ReactFlow>
    </div>
  );
}
