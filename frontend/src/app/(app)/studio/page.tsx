"use client";

import { Wand } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Studio } from "@/components/studio/Studio";
import { Button, Card, EmptyState, ErrorBox, Select, Skeleton } from "@/components/ui";
import { useApi, usePipeline } from "@/lib/hooks";
import type { PipelineSummary } from "@/lib/types";

function StudioInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: list, loading: listLoading } = useApi<PipelineSummary[]>("/api/pipelines");
  const withData = (list ?? []).filter((p) => p.dataset_count > 0);
  const id = params.get("pipeline") ?? withData[0]?.id ?? null;
  const { pipeline, mutate, busy, error, loading } = usePipeline(id);
  useEffect(() => {
    if (!params.get("pipeline") && withData[0]) router.replace(`/studio?pipeline=${withData[0].id}`);
  }, [withData, params, router]);
  return (
    <div className="mx-auto max-w-[1700px] px-6 py-8 md:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transformation Studio</h1>
          <p className="mt-1 text-sm text-slate-500">Transform data without code — with live Before / After previews and AI recommendations.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select className="w-72" value={id ?? ""} onChange={(v) => router.push(`/studio?pipeline=${v}`)} options={withData.map((p) => ({ value: p.id, label: p.name }))} />
          {id && <Link href={`/pipelines/${id}?step=transform`}><Button variant="secondary">Open in wizard</Button></Link>}
        </div>
      </div>
      {listLoading || (loading && id) ? <Skeleton className="h-[560px]" /> : !id ? (
        <Card><EmptyState icon={<Wand />} title="No pipelines with data yet" description="Create a pipeline and connect a source to start transforming." action={<Link href="/pipelines/new"><Button variant="primary">Create Pipeline</Button></Link>} /></Card>
      ) : error ? <ErrorBox error={error} /> : pipeline && <Studio key={pipeline.id} pipeline={pipeline} mutate={mutate} busy={busy} />}
    </div>
  );
}

export default function StudioPage() {
  return <Suspense><StudioInner /></Suspense>;
}
