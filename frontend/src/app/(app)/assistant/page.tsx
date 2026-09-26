"use client";

import { Sparkles } from "lucide-react";
import { useEffect } from "react";
import { AssistantChat } from "@/components/shell/AssistantPanel";
import { Card, Select } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import { useUI } from "@/lib/store";
import type { PipelineSummary } from "@/lib/types";

export default function AssistantPage() {
  const { data } = useApi<PipelineSummary[]>("/api/pipelines");
  const { assistantContext, setAssistantContext } = useUI();
  useEffect(() => {
    if (!assistantContext.pipelineId && data?.[0]) setAssistantContext({ pipelineId: data.find((p) => p.dataset_count > 0)?.id, page: "analyze" });
  }, [data, assistantContext.pipelineId, setAssistantContext]);
  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6 py-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Sparkles className="size-6 text-ai-600" /> AI Assistant</h1>
          <p className="mt-1 text-sm text-slate-500">Grounded in your pipeline's real profile and configuration — it recommends, explains and can add steps for you.</p>
        </div>
        <Select className="w-72" value={assistantContext.pipelineId ?? ""} onChange={(v) => setAssistantContext({ pipelineId: v || undefined, page: "analyze" })} placeholder="Whole workspace" options={(data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
      </div>
      <Card className="min-h-[520px] flex-1 overflow-hidden bg-slate-50/60">
        <AssistantChat key={assistantContext.pipelineId ?? "global"} />
      </Card>
    </div>
  );
}
