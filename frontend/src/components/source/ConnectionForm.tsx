"use client";

import { ArrowDownToLine, ArrowUpFromLine, CircleCheck, CircleX, KeyRound, Plug, Repeat, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Field, Input, KeyValueEditor, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { api, type ApiError } from "@/lib/api";
import { showError } from "@/lib/hooks";
import type { ConnectorSpec, FieldSpec } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "@/components/wizard/common";

export interface TestResult {
  ok: boolean;
  title: string;
  message: string;
  info: Record<string, unknown>;
  technical?: string | null;
}

export type Usage = "source" | "target" | "both";

export interface ConnectionPayload {
  connector: string;
  name: string;
  usage: Usage;
  auth_method: string | null;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  connection_id?: string;
}

function FieldInput({ f, value, onChange }: { f: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (f.type === "select") return <Select value={String(value ?? f.default ?? "")} onChange={onChange} options={f.options} />;
  if (f.type === "boolean") return <Switch checked={Boolean(value ?? f.default)} onCheckedChange={onChange} />;
  if (f.type === "textarea") return <Textarea rows={4} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder ?? ""} />;
  if (f.type === "keyvalue") return <KeyValueEditor value={(value as Record<string, string>) ?? {}} onChange={onChange} />;
  return (
    <Input
      type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
      value={String(value ?? "")}
      onChange={(e) => onChange(f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
      placeholder={f.placeholder ?? (f.default !== undefined && f.default !== null ? String(f.default) : "")}
      autoComplete={f.secret ? "new-password" : "off"}
    />
  );
}

export function TestResultCard({ result }: { result: TestResult }) {
  const [tech, setTech] = useState(false);
  return (
    <div className={cn("rounded-xl border p-4 animate-slide-up", result.ok ? "border-emerald-200 bg-emerald-50/60" : "border-rose-200 bg-rose-50/60")}>
      <div className="flex items-center gap-2 font-semibold">
        {result.ok ? <CircleCheck className="size-5 text-emerald-600" /> : <CircleX className="size-5 text-rose-600" />}
        <span className={result.ok ? "text-emerald-900" : "text-rose-900"}>{result.title}</span>
      </div>
      <div className={cn("mt-1 text-sm", result.ok ? "text-emerald-800" : "text-rose-800")}>{result.message}</div>
      {result.ok && Object.keys(result.info).length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {Object.entries(result.info).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-emerald-700/70">{k}</dt>
              <dd className="font-medium text-emerald-950">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {!result.ok && result.technical && (
        <>
          <button className="mt-2 text-xs font-medium text-rose-700 hover:underline" onClick={() => setTech((v) => !v)}>
            {tech ? "Hide" : "Show"} technical details
          </button>
          {tech && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-white/70 p-2 font-mono text-[11px] text-rose-900">{result.technical}</pre>}
        </>
      )}
    </div>
  );
}

function visible(f: FieldSpec, values: Record<string, unknown>, fields: FieldSpec[]): boolean {
  if (!f.show_if) return true;
  return Object.entries(f.show_if).every(([k, allowed]) => {
    const dep = fields.find((x) => x.name === k);
    const v = values[k] ?? dep?.default;
    return allowed.includes(String(v ?? ""));
  });
}

const USAGE_OPTS: { value: Usage; label: string; icon: React.ReactNode; hint: string }[] = [
  { value: "source", label: "Source", icon: <ArrowDownToLine />, hint: "Read data from it" },
  { value: "target", label: "Target", icon: <ArrowUpFromLine />, hint: "Publish curated data to it" },
  { value: "both", label: "Both", icon: <Repeat />, hint: "Read and publish" },
];

export function ConnectionForm({ spec, onConnect, connectLabel = "Connect & discover", connecting, initial, usage: fixedUsage, defaultUsage = "source", allowedUsages }: {
  spec: ConnectorSpec;
  onConnect: (payload: ConnectionPayload) => void;
  connectLabel?: string;
  connecting?: boolean;
  initial?: Record<string, unknown>;
  /** Force the usage (e.g. "target" when adding a publish target) — hides the chooser. */
  usage?: Usage;
  defaultUsage?: Usage;
  /** Restrict the usage chooser (e.g. a pipeline source can be Source or Both, not Target-only). */
  allowedUsages?: Usage[];
}) {
  const roles = spec.roles ?? ["source"];
  const canTarget = roles.includes("target");
  const canSource = roles.includes("source");
  const [usage, setUsage] = useState<Usage>(fixedUsage ?? (canSource ? (canTarget ? defaultUsage : "source") : "target"));
  const [authId, setAuthId] = useState(spec.auth_methods[0]?.id ?? null);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of spec.config_fields) if (f.default !== undefined && f.default !== null) v[f.name] = f.default;
    return { ...v, ...(initial ?? {}) };
  });
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const auth = spec.auth_methods.find((a) => a.id === authId);
  const allFields = useMemo(() => [...spec.config_fields, ...(auth?.fields ?? [])], [spec, auth]);
  const fields = allFields.filter((f) => visible(f, values, allFields));
  const hasAdvanced = fields.some((f) => f.advanced);

  const payload = (): ConnectionPayload => {
    const config: Record<string, unknown> = {};
    const secrets: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (v === undefined || v === "") continue;
      (f.secret ? secrets : config)[f.name] = v;
    }
    return { connector: spec.id, name: String(values.__name || spec.name), usage, auth_method: authId, config, secrets };
  };

  const missing = fields.filter((f) => f.required && (values[f.name] === undefined || values[f.name] === "")).map((f) => f.label);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.post<TestResult>("/api/connections/test", payload()));
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 403) showError(e);
      else setResult({ ok: false, title: err.title ?? "Connection failed", message: err.message, info: {}, technical: err.technical });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <ConnectorIcon icon={spec.icon} color={spec.color} size="lg" />
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold">
            {spec.name}
            {spec.availability !== "ga" && <Badge tone="sky">{spec.availability === "preview" ? "Preview" : "Sandbox"}</Badge>}
          </div>
          <div className="text-sm text-slate-500">{spec.description}</div>
        </div>
      </div>
      {!fixedUsage && canTarget && (
        <Field label="Use this connection as" help={usage !== "source" ? spec.target_note ?? undefined : undefined}>
          <div className={cn("grid gap-2", allowedUsages && allowedUsages.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
            {USAGE_OPTS.filter((o) => (o.value === "source" ? canSource : o.value === "target" ? canTarget : canSource && canTarget) && (!allowedUsages || allowedUsages.includes(o.value))).map((o) => (
              <button key={o.value} type="button" onClick={() => setUsage(o.value)}
                className={cn("flex items-center gap-2.5 rounded-xl border-2 px-3 py-2 text-left transition-all [&_svg]:size-4",
                  usage === o.value ? "border-brand-400 bg-brand-50/70 text-brand-700" : "border-slate-200/80 bg-white/70 text-slate-600 hover:border-brand-200")}>
                {o.icon}
                <span className="leading-tight"><span className="block text-[13px] font-semibold">{o.label}</span><span className="block text-[11px] text-slate-500">{o.hint}</span></span>
              </button>
            ))}
          </div>
        </Field>
      )}
      {spec.auth_methods.length > 1 && (
        <Field label="Authentication">
          {spec.auth_methods.length > 3 ? (
            <Select value={authId ?? ""} onChange={(v) => { setAuthId(v); setResult(null); }} options={spec.auth_methods.map((a) => ({ value: a.id, label: a.label }))} />
          ) : (
            <Segmented size="sm" value={authId ?? ""} onChange={(v) => { setAuthId(v); setResult(null); }} options={spec.auth_methods.map((a) => ({ value: a.id, label: a.label }))} />
          )}
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Connection name" className="sm:col-span-2">
          <Input value={String(values.__name ?? "")} onChange={(e) => setValues({ ...values, __name: e.target.value })} placeholder={`${spec.name} — production`} />
        </Field>
        {fields.filter((f) => !f.advanced || advanced).map((f) => (
          <Field key={f.name} label={<span className="inline-flex items-center gap-1">{f.secret && <KeyRound className="size-3 text-slate-400" />}{f.label}</span>} required={f.required} help={f.help} className={cn((f.type === "keyvalue" || f.type === "textarea" || f.type === "url") && "sm:col-span-2")}>
            <FieldInput f={f} value={values[f.name]} onChange={(v) => { setValues({ ...values, [f.name]: v }); setResult(null); }} />
          </Field>
        ))}
      </div>
      {hasAdvanced && (
        <button onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700">
          <SlidersHorizontal className="size-4" /> {advanced ? "Hide" : "Show"} advanced settings
        </button>
      )}
      <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        <ShieldCheck className="size-4 text-emerald-600" /> Credentials are encrypted and stored in the secret store — never in pipeline configuration.
      </div>
      {result && <TestResultCard result={result} />}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={test} loading={testing} disabled={missing.length > 0}>
          <Plug /> Test Connection
        </Button>
        <Button variant="primary" onClick={() => onConnect(payload())} loading={connecting} disabled={missing.length > 0 || (result !== null && !result.ok)}>
          {connectLabel}
        </Button>
      </div>
      {missing.length > 0 && <div className="text-right text-xs text-slate-400">Required: {missing.join(", ")}</div>}
    </div>
  );
}
