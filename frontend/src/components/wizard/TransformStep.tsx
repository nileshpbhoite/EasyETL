"use client";

import { Studio } from "@/components/studio/Studio";
import { api } from "@/lib/api";
import type { Pipeline } from "@/lib/types";
import type { StepProps } from "@/app/(app)/pipelines/[id]/page";
import { NextButton, WizardFooter } from "./common";

export function TransformStep({ pipeline, mutate, busy, goTo }: StepProps) {
  const meta = pipeline.metadata;
  const pending = meta.recommendations.filter((r) => r.status === "pending").length;
  return (
    <div className="animate-fade-in">
      <Studio pipeline={pipeline} mutate={mutate} busy={busy} />
      <WizardFooter
        onBack={() => goTo("analyze")}
        note={`${meta.transformations.filter((t) => t.enabled).length} active steps${pending ? ` · ${pending} recommendations pending` : ""}`}
        primary={
          <NextButton onClick={async () => { await mutate("complete", () => api.patch<Pipeline>(`/api/pipelines/${pipeline.id}`, { complete_step: "transform" }), { silent: true }); goTo("configure"); }}>
            Configure ingestion
          </NextButton>
        }
      />
    </div>
  );
}
