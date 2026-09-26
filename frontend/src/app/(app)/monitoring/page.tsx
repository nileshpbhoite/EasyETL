"use client";

import { Activity } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { MonitoringDashboard } from "@/components/monitoring/MonitoringDashboard";
import { Button, Card, EmptyState, Skeleton, StatusBadge } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { PipelineSummary } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";

function MonitoringInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { data, loading } = useApi<PipelineSummary[]>("/api/pipelines");
  const deployed = (data ?? []).filter((p) => p.deployment_status === "deployed");
  const current = params.get("pipeline") ?? deployed[0]?.id;
  useEffect(() => {
    if (!params.get("pipeline") && deployed[0]) router.replace(`/monitoring?pipeline=${deployed[0].id}`);
  }, [deployed, params, router]);
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-8 md:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">Monitoring</h1>
      <p className="mt-1 text-sm text-slate-500">Run health, freshness, quality and cost — with AI watching for anomalies continuously.</p>
      {loading ? <Skeleton className="mt-6 h-96" /> : deployed.length === 0 ? (
        <Card className="mt-6"><EmptyState icon={<Activity />} title="No deployed pipelines" description="Deploy a pipeline to start monitoring it." action={<Link href="/pipelines"><Button variant="primary">View pipelines</Button></Link>} /></Card>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="space-y-2">
            {deployed.map((p) => (
              <button key={p.id} onClick={() => router.push(`/monitoring?pipeline=${p.id}`)} className={cn("w-full rounded-xl border bg-white p-3 text-left shadow-card transition-all", current === p.id ? "border-brand-500 ring-2 ring-brand-100" : "border-slate-200 hover:border-slate-300")}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{p.name}</span><StatusBadge status={p.status} /></div>
                <div className="mt-1 text-xs text-slate-500">{p.source_label} · {p.last_run ? `ran ${timeAgo(p.last_run.started_at)}` : "—"}</div>
              </button>
            ))}
          </div>
          <div>{current && <MonitoringDashboard key={current} pipelineId={current} />}</div>
        </div>
      )}
    </div>
  );
}

export default function MonitoringPage() {
  return <Suspense><MonitoringInner /></Suspense>;
}
