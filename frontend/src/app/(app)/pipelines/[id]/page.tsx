"use client";

import { Check, CloudCheck, History, LayoutTemplate, Lightbulb, LoaderCircle, Pencil, Sparkles, SlidersHorizontal, Undo2, X } from "lucide-react";
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

const GUIDE: Record<Step, string> = {
  source: "Upload a file or pick a system to connect. Not sure where to start? Try one of the sample files.",
  analyze: "AI has profiled your data. Skim what it found — there's nothing to set up here — then continue.",
  transform: "Apply the AI suggestions in one click, or add your own from the library. Every change shows a before/after preview.",
  configure: "We picked the best way to load your data. Keep the recommendation or choose an alternative.",
  design: "Your Bronze → Silver → Gold tables are designed for you. Rename or adjust them only if you want to.",
  review: "A final check before going live. Anything flagged can be fixed with one click.",
  deploy: "One click creates everything in Databricks. You can redeploy at any time.",
  monitor: "Your pipeline is live. We watch every run and alert you if anything looks unusual.",
};

function useTipsHidden() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try { setHidden(localStorage.getItem("easyetl.tips.hidden") === "1"); } catch { /* storage unavailable */ }
  }, []);
  const set = (v: boolean) => {
    setHidden(v);
    try { localStorage.setItem("easyetl.tips.hidden", v ? "1" : "0"); } catch { /* storage unavailable */ }
  };
  return [hidden, set] as const;
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
  const [tipsHidden, setTipsHidden] = useTipsHidden();

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
        <div className="mb-4 flex flex-wrap items-center gap-3">
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
                <button onClick={() => { setName(pipeline.name); setEditingName(true); }} className="font-display group flex items-center gap-2 text-[22px] font-bold tracking-tight text-slate-900">
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
          <div className="flex items-center rounded-xl border border-slate-200/70 bg-white p-0.5 shadow-sm">
            <Tooltip content="Undo last change">
              <Button variant="ghost" size="icon" aria-label="Undo" onClick={() => mutate("undo", () => api.post<Pipeline>(`/api/pipelines/${id}/undo`), { success: "Last change undone" })} disabled={pipeline.version <= 1}><Undo2 /></Button>
            </Tooltip>
            <Tooltip content="Version history">
              <Button variant="ghost" size="icon" aria-label="Version history" onClick={() => setHistoryOpen(true)}><History /></Button>
            </Tooltip>
            <Tooltip content="Save as a reusable template">
              <Button variant="ghost" size="icon" aria-label="Save as template" onClick={() => setTemplateOpen(true)} disabled={!meta.transformations.length}><LayoutTemplate /></Button>
            </Tooltip>
            {tipsHidden && (
              <Tooltip content="Show tips">
                <Button variant="ghost" size="icon" aria-label="Show tips" onClick={() => setTipsHidden(false)}><Lightbulb /></Button>
              </Tooltip>
            )}
          </div>
        </div>
        <Stepper current={step} completed={meta.completed_steps} onSelect={goTo} deployed={meta.deployment.status === "deployed"} />
        {!tipsHidden && GUIDE[step] && (
          <div key={step} className="mt-3 flex items-center gap-3 rounded-xl border border-amber-200/70 bg-gradient-to-r from-amber-50 to-orange-50/40 px-4 py-2.5 animate-slide-up">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600"><Lightbulb className="size-4" /></span>
            <p className="min-w-0 flex-1 text-[13.5px] text-amber-900"><span className="font-semibold">What to do here: </span>{GUIDE[step]}</p>
            <button onClick={() => setTipsHidden(true)} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100" aria-label="Hide tips">
              <X className="size-3.5" /> Hide tips
            </button>
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-[1680px] flex-1 px-5 py-5 md:px-6">
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
