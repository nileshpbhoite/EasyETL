"use client";

import { Activity, MoreHorizontal, Plus, Search, Trash2, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Card, ConfirmDialog, EmptyState, ErrorBox, Input, Progress, Segmented, Skeleton, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import { STEPS, type PipelineSummary } from "@/lib/types";
import { cn, humanize, qualityColor, timeAgo } from "@/lib/utils";

const TILE: Record<string, string> = { file: "from-emerald-400 to-teal-500", application: "from-sky-400 to-brand-500", api: "from-rose-400 to-pink-500", database: "from-ai-400 to-brand-600" };

export default function PipelinesPage() {
  const router = useRouter();
  const { data, error, loading, reload } = useApi<PipelineSummary[]>("/api/pipelines");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "running" | "draft" | "failed">("all");
  const [toDelete, setToDelete] = useState<PipelineSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);

  const rows = useMemo(
    () => (data ?? []).filter((p) => (filter === "all" || p.status === filter || (filter === "draft" && ["draft", "ready"].includes(p.status))) && (p.name + p.source_label).toLowerCase().includes(q.toLowerCase())),
    [data, q, filter],
  );

  const del = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.del(`/api/pipelines/${toDelete.id}`);
      toast.success("Pipeline deleted");
      setToDelete(null);
      void reload();
    } catch (e) {
      showError(e);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] relative px-6 pb-10 pt-2 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[32px] font-bold leading-tight text-slate-900">Pipelines</h1>
          <p className="mt-1.5 max-w-3xl text-[15px] text-slate-600">Every pipeline is stored as validated metadata — resume any draft exactly where you left off.</p>
        </div>
        <Link href="/pipelines/new">
          <Button variant="primary">
            <Plus /> New Pipeline
          </Button>
        </Link>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pipelines" className="pl-9" />
        </div>
        <Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "running", label: "Running" }, { value: "draft", label: "Drafts" }, { value: "failed", label: "Failed" }]} />
      </div>
      <ErrorBox error={error} onRetry={reload} className="mt-4" />
      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading && Array.from({ length: 6 }).map((_, i) => <Card key={i} className="h-44 p-5"><Skeleton className="h-4 w-40" /><Skeleton className="mt-3 h-3 w-24" /></Card>)}
        {!loading && rows.length === 0 && (
          <Card className="md:col-span-2 xl:col-span-3">
            <EmptyState icon={<Workflow />} title={q || filter !== "all" ? "No matching pipelines" : "No pipelines yet"} description="Create a pipeline to connect data and deploy it to Databricks." action={<Link href="/pipelines/new"><Button variant="primary"><Plus /> New Pipeline</Button></Link>} />
          </Card>
        )}
        {rows.map((p) => {
          const stepIdx = STEPS.findIndex((s) => s.id === p.current_step);
          const pct = Math.round((p.completed_steps.length / STEPS.length) * 100);
          const deployed = p.deployment_status === "deployed";
          return (
            <Card key={p.id} className="group relative cursor-pointer p-5 transition-all hover:-translate-y-0.5 hover:shadow-lift" onClick={() => router.push(`/pipelines/${p.id}`)}>
              <div className="flex items-start justify-between gap-3">
                <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-md", TILE[p.source_category ?? "file"] ?? TILE.file)}><Workflow className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-bold text-slate-900">{p.name}</div>
                  <div className="mt-0.5 truncate text-sm text-slate-500">
                    {p.source_label} → {p.target_label}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <StatusBadge status={p.status} />
                  <button
                    className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-100 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenu(menu === p.id ? null : p.id);
                    }}
                    aria-label="More actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </div>
              </div>
              {menu === p.id && (
                <div className="glass absolute right-4 top-12 z-10 w-44 rounded-xl p-1" onClick={(e) => e.stopPropagation()}>
                  {deployed && (
                    <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50" onClick={() => router.push(`/monitoring?pipeline=${p.id}`)}>
                      <Activity className="size-4" /> Monitor
                    </button>
                  )}
                  <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-rose-600 hover:bg-rose-50" onClick={() => { setMenu(null); setToDelete(p); }}>
                    <Trash2 className="size-4" /> Delete
                  </button>
                </div>
              )}
              <div className="mt-5 grid grid-cols-3 gap-3 text-xs">
                <div>
                  <div className="text-slate-400">Datasets</div>
                  <div className="mt-0.5 font-semibold text-slate-800">{p.dataset_count}</div>
                </div>
                <div>
                  <div className="text-slate-400">Quality</div>
                  <div className={cn("mt-0.5 font-semibold", qualityColor(p.quality_score))}>{p.quality_score ? `${p.quality_score}%` : "—"}</div>
                </div>
                <div>
                  <div className="text-slate-400">{deployed ? "Last run" : "Updated"}</div>
                  <div className="mt-0.5 font-semibold text-slate-800">{deployed && p.last_run ? timeAgo(p.last_run.started_at) : timeAgo(p.updated_at)}</div>
                </div>
              </div>
              <div className="mt-4">
                <div className="mb-1.5 flex justify-between text-xs">
                  <span className="text-slate-500">{deployed ? `Deployed · ${humanize(p.frequency)}` : `Step ${stepIdx + 1} of ${STEPS.length}: ${STEPS[stepIdx]?.label}`}</span>
                  <span className="font-medium text-slate-600">{pct}%</span>
                </div>
                <Progress value={pct} tone={deployed ? "green" : "brand"} />
              </div>
            </Card>
          );
        })}
      </div>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(v) => !v && setToDelete(null)}
        title="Delete pipeline?"
        description={<>This permanently deletes <b>{toDelete?.name}</b>, its configuration history and run history in EasyETL. Tables already created in Databricks are not dropped.</>}
        confirmLabel="Delete pipeline"
        destructive
        loading={deleting}
        onConfirm={del}
      />
    </div>
  );
}
