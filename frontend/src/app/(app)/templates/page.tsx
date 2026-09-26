"use client";

import { Download, FileUp, LayoutTemplate, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Card, ConfirmDialog, Dialog, ErrorBox, Field, Input, Segmented, Textarea } from "@/components/ui";
import { api, type ApiError } from "@/lib/api";
import { showError, useApi } from "@/lib/hooks";
import { cn } from "@/lib/utils";

interface Tpl { id: string; name: string; description: string; category: string; source_hint: string; builtin: boolean; uses: number; transform_count: number; highlights: string[]; config: Record<string, unknown> }

const GRADIENTS = ["from-brand-500 to-ai-500", "from-sky-500 to-brand-500", "from-emerald-500 to-teal-500", "from-amber-500 to-orange-500", "from-fuchsia-500 to-ai-600", "from-cyan-500 to-sky-600", "from-slate-600 to-navy-700"];

function TemplatesInner() {
  const params = useSearchParams();
  const { data, reload } = useApi<Tpl[]>("/api/templates");
  const [filter, setFilter] = useState<"all" | "builtin" | "custom">("all");
  const [importOpen, setImportOpen] = useState(false);
  const [json, setJson] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [del, setDel] = useState<Tpl | null>(null);
  useEffect(() => setImportOpen(params.get("import") === "1"), [params]);
  const rows = (data ?? []).filter((t) => filter === "all" || (filter === "builtin" ? t.builtin : !t.builtin));

  const exportTpl = (t: Tpl) => {
    const blob = new Blob([JSON.stringify({ name: t.name, description: t.description, category: t.category, config: t.config }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${t.name.replace(/\W+/g, "_")}.easyetl-template.json`;
    a.click();
  };
  const doImport = async () => {
    setErr(null);
    try {
      const parsed = JSON.parse(json);
      await api.post("/api/templates/import", { name: name || parsed.name || "Imported template", description: parsed.description ?? "", category: parsed.category ?? "Imported", config: parsed.config ?? parsed });
      toast.success("Template imported");
      setImportOpen(false);
      setJson("");
      void reload();
    } catch (e) {
      setErr(e instanceof SyntaxError ? Object.assign(new Error("That doesn't look like a valid template file."), { title: "Invalid template" }) as unknown as ApiError : (e as ApiError));
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
          <p className="mt-1 text-sm text-slate-500">Reusable pipeline configurations: Create Pipeline → Choose Template → Connect Source. Transformations re-bind to the new source's columns automatically.</p>
        </div>
        <div className="flex gap-2">
          <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "builtin", label: "Built-in" }, { value: "custom", label: "Your team" }]} />
          <Button variant="secondary" onClick={() => setImportOpen(true)}><FileUp /> Import Template</Button>
        </div>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((t, i) => (
          <Card key={t.id} className="flex flex-col overflow-hidden">
            <div className={cn("bg-gradient-to-br p-5 text-white", GRADIENTS[i % GRADIENTS.length])}>
              <div className="flex items-center justify-between"><LayoutTemplate className="size-5" /><span className="rounded bg-white/20 px-2 py-0.5 text-[11px] font-medium">{t.builtin ? t.category : "Custom"}</span></div>
              <div className="mt-4 text-lg font-semibold">{t.name}</div>
              <div className="text-xs text-white/80">For {t.source_hint.replace("_", " ")} sources · used {t.uses}×</div>
            </div>
            <div className="flex flex-1 flex-col p-5">
              <p className="text-sm text-slate-600">{t.description || "Saved from a pipeline."}</p>
              <ul className="mt-3 space-y-1">
                {(t.highlights.length ? t.highlights : [`${t.transform_count} transformation patterns`, "Ingestion, Lakehouse & governance settings"]).map((h) => (
                  <li key={h} className="flex gap-2 text-sm text-slate-600"><Sparkles className="mt-0.5 size-3.5 shrink-0 text-ai-500" />{h}</li>
                ))}
              </ul>
              <div className="mt-auto flex items-center gap-2 pt-5">
                <Link href={`/pipelines/new?template=${t.id}`} className="flex-1"><Button variant="primary" className="w-full">Use template</Button></Link>
                <Button variant="ghost" size="icon" onClick={() => exportTpl(t)} aria-label="Export"><Download /></Button>
                {!t.builtin && <Button variant="ghost" size="icon" onClick={() => setDel(t)} aria-label="Delete"><Trash2 /></Button>}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Dialog open={importOpen} onOpenChange={setImportOpen} title="Import template" description="Paste or upload an .easyetl-template.json file shared by another team." size="md"
        footer={<><Button variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button><Button variant="primary" onClick={doImport} disabled={!json.trim()}>Import</Button></>}>
        <div className="space-y-4">
          <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Template file">
            <input type="file" accept=".json,application/json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setJson(await f.text()); }} className="mb-2 block text-sm" />
            <Textarea rows={8} value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"name": "…", "config": {…}}' className="font-mono text-xs" />
          </Field>
          <ErrorBox error={err} />
        </div>
      </Dialog>
      <ConfirmDialog open={!!del} onOpenChange={(v) => !v && setDel(null)} title="Delete template?" description={<>“{del?.name}” will no longer be available to your team.</>} destructive confirmLabel="Delete"
        onConfirm={async () => { try { await api.del(`/api/templates/${del!.id}`); setDel(null); void reload(); } catch (e) { showError(e); } }} />
    </div>
  );
}

export default function TemplatesPage() {
  return <Suspense><TemplatesInner /></Suspense>;
}
