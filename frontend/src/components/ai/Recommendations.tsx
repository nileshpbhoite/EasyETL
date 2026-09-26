"use client";

import { CircleCheck, CircleHelp, Eye, Lightbulb, Sparkles, TriangleAlert, Undo2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { AIBadge, Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, Spinner } from "@/components/ui";
import { BeforeAfter } from "@/components/studio/BeforeAfter";
import { api } from "@/lib/api";
import { showError } from "@/lib/hooks";
import { useUI } from "@/lib/store";
import type { Insight, Pipeline, Preview, Recommendation } from "@/lib/types";
import { cn, fmtNumber } from "@/lib/utils";

const IMPACT = { high: { tone: "red" as const, label: "High impact" }, medium: { tone: "amber" as const, label: "Medium impact" }, low: { tone: "slate" as const, label: "Low impact" } };

export function InsightList({ insights, datasetNames, limit }: { insights: Insight[]; datasetNames?: Record<string, string>; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all || !limit ? insights : insights.slice(0, limit);
  const icon = (s: Insight["severity"]) =>
    s === "critical" ? <TriangleAlert className="size-4 text-rose-500" /> : s === "warning" ? <TriangleAlert className="size-4 text-amber-500" /> : s === "success" ? <CircleCheck className="size-4 text-emerald-500" /> : <Lightbulb className="size-4 text-ai-500" />;
  return (
    <div className="space-y-0.5">
      {shown.map((i) => (
        <div key={i.id} className="flex gap-3 rounded-lg px-3 py-2 hover:bg-white/60">
          <div className="mt-0.5 shrink-0">{icon(i.severity)}</div>
          <div className="min-w-0">
            <div className="text-sm text-slate-800">{i.title}</div>
            {(i.detail || (datasetNames && i.dataset_id)) && (
              <div className="mt-0.5 text-xs text-slate-500">
                {datasetNames && i.dataset_id && <span className="font-medium text-slate-600">{datasetNames[i.dataset_id]}</span>}
                {datasetNames && i.dataset_id && i.detail && " · "}
                {i.detail}
              </div>
            )}
          </div>
        </div>
      ))}
      {limit && insights.length > limit && (
        <button onClick={() => setAll((v) => !v)} className="px-3 py-1.5 text-xs font-medium text-ai-700 hover:underline">
          {all ? "Show fewer" : `Show all ${insights.length} insights`}
        </button>
      )}
    </div>
  );
}

function RecommendationCard({ rec, pipeline, checked, onCheck, onApply, onIgnore, onRestore, dataset }: {
  rec: Recommendation;
  pipeline: Pipeline;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onApply: () => void;
  onIgnore: () => void;
  onRestore: () => void;
  dataset?: string;
}) {
  const [explain, setExplain] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { openAssistant } = useUI();
  const impact = IMPACT[rec.impact];

  const showPreview = async () => {
    setLoadingPreview(true);
    try {
      setPreview(await api.post<Preview>(`/api/pipelines/${pipeline.id}/recommendations/${rec.id}/preview`));
    } catch (e) {
      showError(e);
    } finally {
      setLoadingPreview(false);
    }
  };

  const done = rec.status !== "pending";
  return (
    <div className={cn("rounded-xl border bg-white p-4 transition-all", done ? "border-slate-100 opacity-70" : "border-slate-200 shadow-card hover:shadow-lift")}>
      <div className="flex gap-3">
        {!done ? <Checkbox checked={checked} onChange={onCheck} className="mt-1" /> : rec.status === "applied" ? <CircleCheck className="mt-0.5 size-4 text-emerald-500" /> : <X className="mt-0.5 size-4 text-slate-400" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={impact.tone}>{impact.label}</Badge>
            <Badge tone="ai"><Sparkles /> {Math.round(rec.confidence * 100)}% confidence</Badge>
            {dataset && <Badge>{dataset}</Badge>}
            {rec.destructive && <Badge tone="amber">Removes records</Badge>}
            {rec.status === "applied" && <Badge tone="green">Applied</Badge>}
            {rec.status === "ignored" && <Badge>Ignored</Badge>}
          </div>
          <div className="mt-2 font-semibold text-slate-900">{rec.title}</div>
          <div className="mt-0.5 text-sm text-slate-600">
            <span className="font-medium text-slate-700">Reason: </span>
            {rec.reason}
          </div>
          {rec.expected_benefit && (
            <div className="mt-1 text-sm text-slate-600">
              <span className="font-medium text-slate-700">Benefit: </span>
              {rec.expected_benefit}
            </div>
          )}
          {explain && <div className="mt-3 rounded-lg ai-surface p-3 text-sm text-slate-700 ring-1 ring-ai-100 animate-slide-up"><div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ai-700"><Sparkles className="size-3.5" /> Why AI recommends this</div>{rec.explanation}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {!done ? (
              <>
                <Button size="sm" variant="primary" onClick={() => (rec.destructive ? setConfirm(true) : onApply())}>Apply</Button>
                <Button size="sm" variant="ghost" onClick={onIgnore}>Ignore</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={onRestore}><Undo2 /> {rec.status === "applied" ? "Undo" : "Reconsider"}</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setExplain((v) => !v)}><Lightbulb /> {explain ? "Hide explanation" : "Explanation"}</Button>
            {rec.action.kind === "add_transform" && (
              <Button size="sm" variant="ghost" onClick={showPreview} loading={loadingPreview}><Eye /> Before / After</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => openAssistant({ pipelineId: pipeline.id, recommendationId: rec.id, question: `Why are you recommending "${rec.title}"?`, datasetId: rec.dataset_id ?? undefined })}>
              <CircleHelp /> Ask AI
            </Button>
          </div>
        </div>
      </div>
      <Dialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)} title={rec.title} description="Preview of this change on your data. Nothing is applied until you click Apply." size="xl"
        footer={!done && <><Button variant="ghost" onClick={() => setPreview(null)}>Close</Button><Button variant="primary" onClick={() => { setPreview(null); rec.destructive ? setConfirm(true) : onApply(); }}>Apply</Button></>}>
        {preview && <BeforeAfter preview={preview} />}
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Remove records?"
        description={<>This step removes {rec.affected_rows ? <b>{fmtNumber(rec.affected_rows)} records</b> : "records"} from the cleaned (Silver) data. The raw Bronze copy keeps everything, and you can undo at any time.</>}
        confirmLabel="Apply"
        onConfirm={() => {
          setConfirm(false);
          onApply();
        }}
      />
    </div>
  );
}

export function RecommendationPanel({ pipeline, mutate, datasetFilter, compact }: {
  pipeline: Pipeline;
  mutate: (label: string, fn: () => Promise<Pipeline>, opts?: { success?: string }) => Promise<unknown>;
  datasetFilter?: string | null;
  compact?: boolean;
}) {
  const meta = pipeline.metadata;
  const names = Object.fromEntries(meta.source.datasets.map((d) => [d.id, d.name.split(" › ").pop() ?? d.name]));
  const recs = useMemo(() => meta.recommendations.filter((r) => r.area === "transformation" && (!datasetFilter || r.dataset_id === datasetFilter)), [meta.recommendations, datasetFilter]);
  const pending = recs.filter((r) => r.status === "pending");
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(meta.recommendations.map((r) => [r.id, r.preselected])));
  const [applying, setApplying] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const selectedIds = pending.filter((r) => checked[r.id] ?? r.preselected).map((r) => r.id);

  const apply = async (ids: string[] | null, label: string) => {
    setApplying(true);
    await mutate("apply", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/recommendations/apply`, { ids }), { success: label });
    setApplying(false);
  };
  const setStatus = (id: string, status: string) => mutate("status", () => api.post<Pipeline>(`/api/pipelines/${pipeline.id}/recommendations/${id}/status`, { status }));
  const done = recs.filter((r) => r.status !== "pending");

  return (
    <Card className="overflow-hidden">
      <div className="ai-surface border-b border-ai-100 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-semibold text-ai-900">
              <Sparkles className="size-4 text-ai-600" />
              {pending.length > 0 ? `${pending.length} transformation${pending.length !== 1 ? "s" : ""} recommended` : "All recommendations reviewed"}
              <AIBadge label="Best practice" />
            </div>
            <div className="mt-0.5 text-xs text-ai-800/70">Each recommendation is validated by the policy engine. Nothing changes until you approve it.</div>
          </div>
          {pending.length > 0 && (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => apply(selectedIds, `Applied ${selectedIds.length} recommendations`)} disabled={!selectedIds.length || applying}>
                Apply Selected ({selectedIds.length})
              </Button>
              <Button size="sm" variant="ai" onClick={() => apply(pending.map((r) => r.id), `Applied ${pending.length} recommendations`)} loading={applying}>
                <Sparkles /> Apply All
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className={cn("space-y-3 p-4", compact && "max-h-[640px] overflow-y-auto scrollbar-thin")}>
        {applying && <div className="flex items-center gap-2 px-1 text-sm text-ai-700"><Spinner className="text-ai-600" /> Validating & applying…</div>}
        {pending.map((r) => (
          <RecommendationCard key={r.id} rec={r} pipeline={pipeline} dataset={datasetFilter ? undefined : names[r.dataset_id ?? ""]} checked={checked[r.id] ?? r.preselected}
            onCheck={(v) => setChecked({ ...checked, [r.id]: v })} onApply={() => apply([r.id], `Applied: ${r.title}`)} onIgnore={() => setStatus(r.id, "ignored")} onRestore={() => setStatus(r.id, "pending")} />
        ))}
        {pending.length === 0 && recs.length === 0 && <div className="py-6 text-center text-sm text-slate-500">No recommendations — this data already follows best practices.</div>}
        {done.length > 0 && (
          <button className="px-1 text-xs font-medium text-slate-500 hover:text-slate-700" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Hide" : "Show"} {done.length} reviewed recommendation{done.length !== 1 ? "s" : ""}
          </button>
        )}
        {showDone && done.map((r) => (
          <RecommendationCard key={r.id} rec={r} pipeline={pipeline} dataset={datasetFilter ? undefined : names[r.dataset_id ?? ""]} checked={false} onCheck={() => undefined}
            onApply={() => undefined} onIgnore={() => undefined} onRestore={() => setStatus(r.id, "pending")} />
        ))}
      </div>
    </Card>
  );
}
