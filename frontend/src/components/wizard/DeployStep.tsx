"use client";

import { CircleCheck, CircleX, Code, ExternalLink, FileCode, LoaderCircle, Rocket, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Callout, Card, CardHeader, Dialog, ErrorBox, Segmented } from "@/components/ui";
import { api, getStoredUser, type ApiError } from "@/lib/api";
import { useUI } from "@/lib/store";
import type { Pipeline } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { Cylinder } from "@/components/lakehouse/Cylinder";
import { NextButton, SectionCard, WizardFooter } from "./common";

const STEPS = [
  "Validating pipeline metadata", "Generating Databricks bundle", "Creating Unity Catalog catalog & schemas", "Uploading runtime and configuration",
  "Creating Lakeflow Declarative Pipeline", "Creating orchestration job & schedule", "Applying governance (grants, tags, column masks)", "Starting the first run",
];

function TechnicalDetails({ pipelineId, open, onOpenChange }: { pipelineId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [active, setActive] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!open) return;
    api.get<{ files: Record<string, string> }>(`/api/pipelines/${pipelineId}/bundle`).then((r) => { setFiles(r.files); setActive(Object.keys(r.files)[0]); }).catch(setError);
  }, [open, pipelineId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Technical details" description="Generated automatically from your pipeline metadata. You never need to edit these." size="xl">
      <ErrorBox error={error} />
      {files && (
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <div className="space-y-0.5">
            {Object.keys(files).map((f) => (
              <button key={f} onClick={() => setActive(f)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs", active === f ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50")}>
                <FileCode className="size-3.5 shrink-0" /> {f}
              </button>
            ))}
          </div>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-navy-950 p-4 font-mono text-[11.5px] leading-relaxed text-slate-200 scrollbar-thin">{files[active]}</pre>
        </div>
      )}
    </Dialog>
  );
}

export function DeployStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const meta = pipeline.metadata;
  const dep = meta.deployment;
  const { environment, setEnvironment } = useUI();
  const [env, setEnv] = useState(pipeline.environment || environment);
  const [progress, setProgress] = useState<number>(dep.status === "deployed" ? STEPS.length : -1);
  const [error, setError] = useState<ApiError | null>(null);
  const [tech, setTech] = useState(false);
  const user = typeof window !== "undefined" ? getStoredUser() : null;
  const canDeploy = user?.permissions.includes("deploy");
  const canSeeTech = canDeploy;

  const deploy = async () => {
    setError(null);
    setProgress(0);
    const timer = setInterval(() => setProgress((p) => (p < STEPS.length - 1 ? p + 1 : p)), 650);
    try {
      const res = await api.post<Pipeline>(`/api/pipelines/${pipeline.id}/deploy`, { environment: env });
      clearInterval(timer);
      if (res.metadata.deployment.status === "deployed") {
        for (let i = progress; i <= STEPS.length; i++) await new Promise((r) => setTimeout(r, 180)).then(() => setProgress(i));
        await mutate("reload", async () => res);
        setEnvironment(env);
        toast.success("Deployed to Databricks 🎉", { description: `${meta.lakehouse.tables.filter((t) => t.enabled).length} tables · ${env}` });
      } else {
        await mutate("reload", async () => res);
        setProgress(-1);
      }
    } catch (e) {
      clearInterval(timer);
      setProgress(-1);
      setError(e as ApiError);
    }
  };

  const params = useSearchParams();
  const router = useRouter();
  const autostarted = useRef(false);
  useEffect(() => {
    if (autostarted.current || params.get("autostart") !== "1") return;
    autostarted.current = true;
    router.replace(`/pipelines/${pipeline.id}?step=deploy`, { scroll: false });
    if (canDeploy && meta.health_check.ready && dep.status !== "deployed") deploy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const deploying = progress >= 0 && progress < STEPS.length && dep.status !== "deployed";
  const done = dep.status === "deployed" && !deploying;
  const tables = dep.resources.filter((r) => r.type === "table");

  return (
    <div className="animate-fade-in">
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <SectionCard icon={<Rocket />} title="Create & Deploy" subtitle="EasyETL generates and deploys everything — Unity Catalog, Lakeflow pipeline, jobs, governance — from your validated metadata." bodyClassName="p-0">
            <div className={cn("relative overflow-hidden border-b px-6 py-7", done ? "border-emerald-100 bg-emerald-50/70" : "border-brand-100 bg-gradient-to-br from-brand-50 to-white")}>
              <div className="relative flex flex-wrap items-center gap-6">
                <div className={cn("flex size-14 items-center justify-center rounded-2xl text-white shadow-lg", done ? "bg-emerald-500" : "gradient-primary", deploying && "animate-pulse")}>
                  {done ? <CircleCheck className="size-8" /> : deploying ? <LoaderCircle className="size-8 animate-spin" /> : <Rocket className="size-8" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-semibold text-slate-900">{done ? "Your pipeline is live on Databricks" : deploying ? "Deploying to Databricks…" : "Ready to deploy"}</div>
                  <div className="mt-1 text-sm text-slate-600">
                    {done ? `Deployed ${timeAgo(dep.deployed_at)} to ${dep.target_environment}${dep.mode === "mock" ? " · simulation mode (no workspace connected)" : ""}` : `${meta.lakehouse.tables.filter((t) => t.enabled).length} tables · ${meta.transformations.filter((t) => t.enabled).length} transformations · ${meta.quality_rules.filter((r) => r.enabled).length} quality rules`}
                  </div>
                </div>
                {!deploying && (
                  <div className="flex flex-col items-end gap-2">
                    <Segmented size="sm" value={env} onChange={setEnv} options={[{ value: "development", label: "Development" }, { value: "staging", label: "Staging" }, { value: "production", label: "Production" }]} />
                    <Button variant="primary" size="lg" onClick={deploy} disabled={!canDeploy || !meta.health_check.ready}>
                      <Rocket /> {done ? "Redeploy to Databricks" : "Deploy to Databricks"}
                    </Button>
                  </div>
                )}
              </div>
              <div className="relative mt-5 flex items-center gap-3 text-xs text-slate-500">
                {(["bronze", "silver", "gold"] as const).map((l, i) => (
                  <div key={l} className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5"><Cylinder layer={l} size={26} /><span className="font-medium capitalize text-slate-700">{l}</span><span>{meta.lakehouse.tables.filter((t) => t.enabled && t.layer === l).length} tables</span></div>
                    {i < 2 && <span className="text-slate-300">→</span>}
                  </div>
                ))}
              </div>
            </div>
            <div className="p-6">
              {!canDeploy && <Callout tone="warning" className="mb-4">Your role can't deploy. Ask a data engineer or admin to deploy this pipeline.</Callout>}
              {!meta.health_check.ready && <Callout tone="warning" className="mb-4" action={<Button size="sm" onClick={() => goTo("review")}>Open review</Button>}>The readiness check hasn't passed yet.</Callout>}
              <ErrorBox error={error} className="mb-4" onRetry={deploy} />
              {dep.error && <ErrorBox error={Object.assign(new Error(dep.error.message), { title: dep.error.title, technical: dep.error.technical })} className="mb-4" />}
              <ol className="space-y-2.5">
                {STEPS.map((s, i) => {
                  const state = done || progress > i ? "done" : progress === i ? "active" : "todo";
                  return (
                    <li key={s} className="flex items-center gap-3">
                      <span className={cn("flex size-6 items-center justify-center rounded-full text-[11px] font-semibold", state === "done" ? "bg-emerald-500 text-white" : state === "active" ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-400")}>
                        {state === "done" ? "✓" : state === "active" ? <LoaderCircle className="size-3.5 animate-spin" /> : i + 1}
                      </span>
                      <span className={cn("text-sm", state === "todo" ? "text-slate-400" : "text-slate-800", state === "active" && "font-medium")}>{s}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </SectionCard>
          {done && tables.length > 0 && (
            <Card>
              <CardHeader title="Created in Databricks" description={dep.workspace_url ?? ""} icon={<ShieldCheck />} actions={canSeeTech && <Button variant="ghost" size="sm" onClick={() => setTech(true)}><Code /> Show technical details</Button>} />
              <div className="grid gap-x-8 gap-y-1 p-5 md:grid-cols-2">
                {dep.resources.filter((r) => r.type !== "bundle").map((r) => (
                  <div key={r.type + r.name} className="flex items-center gap-2 py-1 text-sm">
                    <Badge tone={r.layer === "bronze" ? "bronze" : r.layer === "silver" ? "silver" : r.layer === "gold" ? "gold" : r.type === "pipeline" ? "dbx" : "slate"} className="w-20 justify-center capitalize">{r.layer ?? r.type}</Badge>
                    <code className="truncate text-xs text-slate-700">{r.name}</code>
                    {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-brand-600"><ExternalLink className="size-3.5" /></a>}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card className="p-5">
            <div className="text-sm font-semibold">What EasyETL deploys</div>
            <ul className="mt-3 space-y-2 text-sm text-slate-600">
              {["Unity Catalog catalog + Bronze/Silver/Gold schemas", `${meta.ingestion.engine === "auto_loader" ? "Auto Loader" : "Managed"} ingestion with checkpointing`, "Lakeflow Declarative Pipeline with quality expectations", "Scheduled job with retries & alerts", "Grants, tags, PII column masks, lineage & audit"].map((x) => (
                <li key={x} className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />{x}</li>
              ))}
            </ul>
            {canSeeTech && <Button variant="link" size="sm" className="mt-3" onClick={() => setTech(true)}><Code /> Show technical details</Button>}
          </Card>
          {dep.mode === "mock" && (
            <Callout tone="info" title="Safe simulation mode">No Databricks workspace is connected, so deployment is simulated end-to-end. Connect a workspace in Settings to deploy for real — nothing else changes.</Callout>
          )}
          {dep.status === "failed" && <Card className="p-4"><div className="flex items-center gap-2 text-sm text-rose-700"><CircleX className="size-4" /> Last deployment failed at “{dep.error?.step}”.</div></Card>}
        </div>
      </div>
      <TechnicalDetails pipelineId={pipeline.id} open={tech} onOpenChange={setTech} />
      <WizardFooter onBack={() => goTo("review")} primary={<NextButton disabled={!done} onClick={() => goTo("monitor")}>Open monitoring</NextButton>} note={busy ? "Working…" : undefined} />
    </div>
  );
}
