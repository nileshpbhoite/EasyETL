"use client";

import { ArrowRight, FileUp, LayoutTemplate, Plug, Sparkles, SlidersHorizontal } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import type { Pipeline } from "@/lib/types";
import { cn } from "@/lib/utils";

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  category: string;
  builtin: boolean;
}

function NewPipeline() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: templates } = useApi<TemplateRow[]>("/api/templates");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [start, setStart] = useState<"file" | "connect" | "template">(params.get("template") ? "template" : "file");
  const [templateId, setTemplateId] = useState<string | null>(params.get("template"));
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (templateId && templates && !name) {
      const t = templates.find((x) => x.id === templateId);
      if (t) setName(`${t.name} pipeline`);
    }
  }, [templateId, templates, name]);

  const create = async () => {
    setCreating(true);
    try {
      const p = await api.post<Pipeline>("/api/pipelines", { name: name || "Untitled pipeline", mode, template_id: start === "template" ? templateId : null });
      router.push(`/pipelines/${p.id}?step=source${start === "connect" ? "&tab=application" : ""}`);
    } catch (e) {
      showError(e);
      setCreating(false);
    }
  };

  const options = [
    { id: "file" as const, icon: FileUp, title: "Upload a file", desc: "Excel, CSV, JSON, XML, Parquet, Avro or ZIP" },
    { id: "connect" as const, icon: Plug, title: "Connect a system", desc: "Salesforce, SAP, SQL Server, REST API, S3…" },
    { id: "template" as const, icon: LayoutTemplate, title: "Start from a template", desc: "Reuse a proven configuration" },
  ];

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl gradient-primary text-white shadow-glow">
          <Sparkles className="size-6" />
        </div>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">Create a pipeline</h1>
        <p className="mt-2 text-slate-500">Source → Analyze → Transform → Configure → Design → Review → Deploy → Monitor</p>
      </div>
      <Card className="mt-8 p-6">
        <div className="grid gap-3 md:grid-cols-3">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => setStart(o.id)}
              className={cn("rounded-xl border-2 p-4 text-left transition-all", start === o.id ? "border-brand-500 bg-brand-50/60 shadow-card" : "border-slate-200 hover:border-slate-300")}
            >
              <o.icon className={cn("size-5", start === o.id ? "text-brand-600" : "text-slate-400")} />
              <div className="mt-3 font-semibold text-slate-900">{o.title}</div>
              <div className="text-sm text-slate-500">{o.desc}</div>
            </button>
          ))}
        </div>
        {start === "template" && (
          <div className="mt-5 grid max-h-72 gap-2 overflow-y-auto pr-1 scrollbar-thin md:grid-cols-2">
            {(templates ?? []).map((t) => (
              <button key={t.id} onClick={() => { setTemplateId(t.id); setName(`${t.name} pipeline`); }} className={cn("rounded-lg border p-3 text-left", templateId === t.id ? "border-brand-500 bg-brand-50/60" : "border-slate-200 hover:border-slate-300")}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{t.name}</span>
                  <Badge tone={t.builtin ? "brand" : "slate"}>{t.builtin ? t.category : "Custom"}</Badge>
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-slate-500">{t.description}</div>
              </button>
            ))}
          </div>
        )}
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <Field label="Pipeline name" help="You can rename it any time.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer 360" autoFocus />
          </Field>
          <Field label="Experience" help={mode === "simple" ? "EasyETL makes the technical decisions for you. Recommended." : "Control ingestion, schema, clustering, compute and more."}>
            <Segmented value={mode} onChange={setMode} options={[{ value: "simple", label: "Simple Mode", icon: <Sparkles /> }, { value: "advanced", label: "Advanced Mode", icon: <SlidersHorizontal /> }]} />
          </Field>
        </div>
        <div className="mt-6 flex justify-end">
          <Button variant="primary" size="lg" onClick={create} loading={creating} disabled={start === "template" && !templateId}>
            Continue <ArrowRight />
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function NewPipelinePage() {
  return (
    <Suspense>
      <NewPipeline />
    </Suspense>
  );
}
