"use client";

import { Check, CloudCheck, History, LayoutTemplate, LoaderCircle, Pencil, Sparkles, SlidersHorizontal, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Badge, Button, Dialog, ErrorBox, Field, Input, Segmented, Skeleton, Textarea } from "@/components/ui";
import { Stepper } from "@/components/wizard/Stepper";
import { SourceStep } from "@/components/wizard/SourceStep";
import { AnalyzeStep } from "@/components/wizard/AnalyzeStep";
import { TransformStep } from "@/components/wizard/TransformStep";
import { ConfigureStep } from "@/components/wizard/ConfigureStep";
import { DesignStep } from "@/components/wizard/DesignStep";
import { ReviewStep } from "@/components/wizard/ReviewStep";
import { DeployStep } from "@/components/wizard/DeployStep";
import { MonitoringDashboard } from "@/components/monitoring/MonitoringDashboard";
import { SaveTemplateDialog } from "@/components/wizard/SaveTemplateDialog";
import { api } from "@/lib/api";
import { showError, useApi, usePipeline } from "@/lib/hooks";
import { useUI } from "@/lib/store";
import { STEPS, type Pipeline, type Step } from "@/lib/types";
import { timeAgo } from "@/lib/utils";

export interface StepProps {
  pipeline: Pipeline;
  mutate: ReturnType<typeof usePipeline>["mutate"];
  busy: string | null;
  goTo: (s: Step) => void;
  reload: () => Promise<void>;
}

function HistoryDialog({ id, open, onOpenChange, onRestore }: { id: string; open: boolean; onOpenChange: (v: boolean) => void; onRestore: (v: number) => void }) {
  const { data } = useApi<{ versions: { version: number; summary: string; at: string }[] }>(open ? `/api/pipelines/${id}/history` : null, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Version history" description="Every change is saved automatically. Restore any earlier version." size="md">
      <div className="space-y-1">
        {data?.versions.map((v, i) => (
          <div key={v.version} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-slate-50">
            <div>
              <div className="text-sm font-medium text-slate-800">{v.summary}</div>
              <div className="text-xs text-slate-500">
                v{v.version} · {timeAgo(v.at)}
              </div>
            </div>
            {i === 0 ? <Badge tone="green">Current</Badge> : <Button size="sm" variant="ghost" onClick={() => onRestore(v.version)}>Restore</Button>}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function Wizard() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { pipeline, error, loading, mutate, busy, reload } = usePipeline(id);
  const { setAssistantContext } = useUI();
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  const step = (search.get("step") as Step) || pipeline?.metadata.current_step || "source";

  useEffect(() => {
    setAssistantContext({ pipelineId: id, page: step });
  }, [id, step, setAssistantContext]);

  useEffect(() => {
    if (pipeline && !search.get("step")) router.replace(`/pipelines/${id}?step=${pipeline.metadata.current_step}`);
  }, [pipeline, search, id, router]);

  const goTo = (s: Step) => {
    router.push(`/pipelines/${id}?step=${s}`);
    void api.patch(`/api/pipelines/${id}`, { current_step: s }).catch(() => undefined);
  };

  if (loading && !pipeline)
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (error && !pipeline) return <div className="p-8"><ErrorBox error={error} onRetry={reload} /></div>;
  if (!pipeline) return null;

  const meta = pipeline.metadata;
  const props: StepProps = { pipeline, mutate, busy, goTo, reload };
  const saveName = async () => {
    setEditingName(false);
    if (name && name !== pipeline.name) await mutate("rename", () => api.patch<Pipeline>(`/api/pipelines/${id}`, { name }));
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto w-full max-w-[1680px] px-5 pt-5 md:px-6">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            {editingName ? (
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                className="w-full max-w-lg rounded-md border border-brand-300 bg-white px-2 py-0.5 text-lg font-semibold outline-none ring-2 ring-brand-100"
              />
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <button onClick={() => { setName(pipeline.name); setEditingName(true); }} className="group flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900">
                  {pipeline.name}
                  <Pencil className="size-3.5 text-slate-300 group-hover:text-slate-500" />
                </button>
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  {busy ? (
                    <span className="flex items-center gap-1 text-brand-600"><LoaderCircle className="size-3 animate-spin" /> Saving…</span>
                  ) : (
                    <span className="flex items-center gap-1"><CloudCheck className="size-3.5 text-emerald-500" /> Saved · v{pipeline.version} · {timeAgo(pipeline.updated_at)}</span>
                  )}
                  <span>·</span>
                  <span className="capitalize">{pipeline.environment}</span>
                  {meta.deployment.status === "deployed" && <Badge tone="green"><Check /> Deployed</Badge>}
                </span>
              </div>
            )}
          </div>
          <Segmented
            size="sm"
            value={meta.mode}
            onChange={(v) => mutate("mode", () => api.patch<Pipeline>(`/api/pipelines/${id}`, { mode: v }))}
            options={[{ value: "simple", label: "Simple", icon: <Sparkles /> }, { value: "advanced", label: "Advanced", icon: <SlidersHorizontal /> }]}
          />
          <Button variant="ghost" size="sm" onClick={() => mutate("undo", () => api.post<Pipeline>(`/api/pipelines/${id}/undo`), { success: "Last change undone" })} disabled={pipeline.version <= 1}>
            <Undo2 /> Undo
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History /> History
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setTemplateOpen(true)} disabled={!meta.transformations.length}>
            <LayoutTemplate /> Save as Template
          </Button>
        </div>
        <Stepper current={step} completed={meta.completed_steps} onSelect={goTo} deployed={meta.deployment.status === "deployed"} />
      </div>
      <div className="mx-auto w-full max-w-[1680px] flex-1 px-5 py-5 md:px-6">
        {step === "source" && <SourceStep {...props} />}
        {step === "analyze" && <AnalyzeStep {...props} />}
        {step === "transform" && <TransformStep {...props} />}
        {step === "configure" && <ConfigureStep {...props} />}
        {step === "design" && <DesignStep {...props} />}
        {step === "review" && <ReviewStep {...props} />}
        {step === "deploy" && <DeployStep {...props} />}
        {step === "monitor" && <MonitoringDashboard pipelineId={id} embedded />}
        {!STEPS.some((s) => s.id === step) && <ErrorBox error={new Error("Unknown step")} />}
      </div>
      <SaveTemplateDialog key={pipeline.name} id={id} open={templateOpen} onOpenChange={setTemplateOpen} defaultName={`${pipeline.name} template`} />
      <HistoryDialog
        id={id}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestore={async (v) => {
          setHistoryOpen(false);
          await mutate("restore", () => api.post<Pipeline>(`/api/pipelines/${id}/versions/${v}/restore`), { success: `Restored version ${v}` });
        }}
      />
    </div>
  );
}

export default function PipelinePage() {
  return (
    <Suspense>
      <Wizard />
    </Suspense>
  );
}
