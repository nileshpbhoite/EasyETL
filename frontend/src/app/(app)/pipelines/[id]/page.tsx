"use client";

import { ArrowLeft, Check, CloudCheck, History, LayoutTemplate, LoaderCircle, Pencil, Sparkles, SlidersHorizontal, Undo2 } from "lucide-react";
import Link from "next/link";
import { FlowArt } from "@/components/art";
import { toast } from "sonner";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Badge, Button, Dialog, ErrorBox, Segmented, Skeleton, Tooltip } from "@/components/ui";
import { WizardStepContext } from "@/components/wizard/common";
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

/** One-line description of each step, shown under the pipeline title. */
const GUIDE: Record<Step, string> = {
  source: "Connect a source or upload a file. Just exploring? Try one of the sample files.",
  analyze: "Analyze your data to discover insights, quality issues and recommendations.",
  transform: "Clean, standardize and enrich your data. Every change is previewed on your real data.",
  configure: "Choose how your data is loaded. We've recommended the best option for this source.",
  design: "Design your Bronze → Silver → Gold Lakehouse. Everything is pre-filled; adjust only if you want to.",
  review: "Review everything in one place. Anything flagged can be fixed with one click.",
  deploy: "Deploy to Databricks in one click: catalog, pipeline, jobs and governance.",
  monitor: "Your pipeline is live. Track runs, freshness, quality and AI alerts.",
};

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
      <div className="relative mx-auto w-full max-w-[1680px] px-5 pt-1 md:px-8">
        <FlowArt className="absolute -top-3 right-6 hidden h-[170px] w-[340px] xl:block" />
        <Link href="/pipelines" className="inline-flex items-center gap-2 text-[14px] font-medium text-slate-600 hover:text-slate-900"><ArrowLeft className="size-4" /> Back to Pipelines</Link>
        <div className="relative mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 xl:pr-[360px]">
          {editingName ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              className="font-display w-full max-w-xl rounded-xl border border-brand-300 bg-white/90 px-3 py-1 text-[28px] font-bold outline-none ring-4 ring-brand-100"
            />
          ) : (
            <button onClick={() => { setName(pipeline.name); setEditingName(true); }} className="font-display group flex items-center gap-3 text-left text-[30px] font-bold leading-tight tracking-tight text-slate-900 md:text-[34px]">
              {pipeline.name}
              <Pencil className="size-5 shrink-0 text-slate-400 group-hover:text-brand-600" />
            </button>
          )}
          <span className="rounded-full bg-brand-50 px-3 py-1 text-[12.5px] font-semibold capitalize text-brand-700 ring-1 ring-brand-100">{pipeline.environment}</span>
          {meta.deployment.status === "deployed" && <Badge tone="green" className="px-3 py-1 text-[12.5px]"><Check /> Deployed</Badge>}
          <span className="flex items-center gap-1.5 text-[13.5px] text-slate-500">
            {busy ? <><LoaderCircle className="size-4 animate-spin text-brand-600" /> Saving…</> : <><CloudCheck className="size-4" /> Saved {timeAgo(pipeline.updated_at)}</>}
          </span>
        </div>
        <div className="relative mt-2 flex flex-wrap items-center gap-3 xl:pr-[360px]">
          <p className="min-w-0 flex-1 text-[15px] text-slate-600">{GUIDE[step]}</p>
          <Segmented
            size="sm"
            value={meta.mode}
            onChange={(v) => mutate("mode", () => api.patch<Pipeline>(`/api/pipelines/${id}`, { mode: v }))}
            options={[{ value: "simple", label: "Simple", icon: <Sparkles /> }, { value: "advanced", label: "Advanced", icon: <SlidersHorizontal /> }]}
          />
          <div className="glass-soft flex items-center rounded-xl p-0.5">
            <Tooltip content="Undo last change">
              <Button variant="ghost" size="icon" aria-label="Undo" onClick={() => mutate("undo", () => api.post<Pipeline>(`/api/pipelines/${id}/undo`), { success: "Last change undone" })} disabled={pipeline.version <= 1}><Undo2 /></Button>
            </Tooltip>
            <Tooltip content={`Version history (v${pipeline.version})`}>
              <Button variant="ghost" size="icon" aria-label="Version history" onClick={() => setHistoryOpen(true)}><History /></Button>
            </Tooltip>
            <Tooltip content="Save as a reusable template">
              <Button variant="ghost" size="icon" aria-label="Save as template" onClick={() => setTemplateOpen(true)} disabled={!meta.transformations.length}><LayoutTemplate /></Button>
            </Tooltip>
          </div>
        </div>
        <div className="relative mt-5">
          <Stepper current={step} completed={meta.completed_steps} onSelect={goTo} deployed={meta.deployment.status === "deployed"} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[1680px] flex-1 px-5 py-5 md:px-8">
        <WizardStepContext.Provider value={{ index: Math.max(0, STEPS.findIndex((s) => s.id === step)), total: STEPS.length, label: STEPS.find((s) => s.id === step)?.label ?? "" }}>
        {step === "source" && <SourceStep {...props} />}
        {step === "analyze" && <AnalyzeStep {...props} />}
        {step === "transform" && <TransformStep {...props} />}
        {step === "configure" && <ConfigureStep {...props} />}
        {step === "design" && <DesignStep {...props} />}
        {step === "review" && <ReviewStep {...props} />}
        {step === "deploy" && <DeployStep {...props} />}
        {step === "monitor" && <MonitoringDashboard pipelineId={id} embedded />}
        {!STEPS.some((s) => s.id === step) && <ErrorBox error={new Error("Unknown step")} />}
        </WizardStepContext.Provider>
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
