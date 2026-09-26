"use client";

import { Brain, CircleCheck, CircleX, FileClock, KeyRound, Server, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import { Badge, Callout, Card, CardHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { getStoredUser } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { humanize, timeAgo } from "@/lib/utils";

const MATRIX: [string, string[]][] = [
  ["View pipelines, catalog & monitoring", ["admin", "data_engineer", "analyst", "viewer"]],
  ["Create & edit pipelines and transformations", ["admin", "data_engineer", "analyst"]],
  ["Manage connections & credentials", ["admin", "data_engineer"]],
  ["Deploy to Databricks, pause & run", ["admin", "data_engineer"]],
  ["Audit log & workspace administration", ["admin"]],
];

export default function SettingsPage() {
  const { data } = useApi<{ ai_provider: string; databricks_connected: boolean; databricks_host?: string; environment: string;
    deployment_connection?: { id: string; name: string; host: string; demo: boolean; auth: string; connection_type?: string } }>("/api/settings");
  const user = typeof window !== "undefined" ? getStoredUser() : null;
  const isAdmin = user?.role === "admin";
  const { data: audit } = useApi<{ id: number; action: string; resource: string; user_id?: string; details: Record<string, unknown>; at: string }[]>(isAdmin ? "/api/audit?limit=100" : null);
  return (
    <div className="mx-auto max-w-5xl relative px-6 pb-10 pt-2 md:px-8">
      <h1 className="text-[32px] font-bold leading-tight text-slate-900">Settings</h1>
      <Tabs defaultValue="workspace" className="mt-6">
        <TabsList>
          <TabsTrigger value="workspace"><Server /> Workspace</TabsTrigger>
          <TabsTrigger value="security"><ShieldCheck /> Security & roles</TabsTrigger>
          {isAdmin && <TabsTrigger value="audit"><FileClock /> Audit log</TabsTrigger>}
        </TabsList>
        <TabsContent value="workspace" className="mt-6 space-y-6">
          <Card>
            <CardHeader title="Databricks workspace" description="Where pipelines are deployed" icon={<Server />} actions={data?.databricks_connected ? <Badge tone="green"><CircleCheck /> Connected</Badge> : <Badge tone="amber"><CircleX /> Not connected</Badge>} />
            <div className="space-y-3 p-5 text-sm text-slate-600">
              {data?.deployment_connection && (
                <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  <div>Connection: <b>{data.deployment_connection.name}</b></div>
                  <div>Workspace: <code>{data.deployment_connection.host}</code>{data.deployment_connection.demo && " (simulated)"}</div>
                  <div>Authentication: <b>{data.deployment_connection.auth}</b></div>
                  <div>Connects through: <b>{humanize(data.deployment_connection.connection_type ?? "sql_warehouse")}</b></div>
                </div>
              )}
              {data?.databricks_connected && !data.deployment_connection && <div>Workspace: <code>{data.databricks_host}</code> (server configuration)</div>}
              {!data?.databricks_connected && (
                <Callout tone="info" title="Running in safe simulation mode">
                  Deployments, runs and monitoring are simulated end-to-end. To deploy for real, add a <b>Databricks</b> connection on the Sources & Targets page
                  (personal access token, OAuth service principal, Entra ID service principal, managed identity, Azure CLI, GCP service account or a CLI profile)
                  and switch on <b>Deploy here</b>. The same deployment flow is used — no pipeline changes needed.
                  <div className="mt-2"><Link href="/sources" className="font-semibold text-brand-600 hover:underline">Connect Databricks →</Link></div>
                </Callout>
              )}
              <div>Environment: <b>{data?.environment}</b></div>
            </div>
          </Card>
          <Card>
            <CardHeader title="AI provider" description="How recommendations and answers are generated" icon={<Brain />} actions={<Badge tone="ai">{data?.ai_provider === "anthropic" ? "Claude + deterministic engine" : "Deterministic expert engine"}</Badge>} />
            <div className="p-5 text-sm text-slate-600">
              AI never touches Databricks directly: <b>Profiler → AI recommendations (JSON) → Policy engine → Validated metadata → Pipeline generator → Databricks</b>. Set <code>EASYETL_AI_PROVIDER=anthropic</code> and <code>EASYETL_ANTHROPIC_API_KEY</code> to add Claude on top of the built-in engine; only profile statistics (never full datasets) are sent.
            </div>
          </Card>
        </TabsContent>
        <TabsContent value="security" className="mt-6 space-y-6">
          <Card>
            <CardHeader title="Roles & permissions" description="Role-based access control, enforced on every API call" icon={<Users />} />
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">Permission</th>{["admin", "data_engineer", "analyst", "viewer"].map((r) => <th key={r} className="px-3 py-2 text-center font-medium">{humanize(r)}</th>)}</tr></thead>
              <tbody>{MATRIX.map(([p, roles]) => <tr key={p} className="border-b border-slate-50"><td className="px-5 py-2.5">{p}</td>{["admin", "data_engineer", "analyst", "viewer"].map((r) => <td key={r} className="px-3 py-2.5 text-center">{roles.includes(r) ? <CircleCheck className="mx-auto size-4 text-emerald-500" /> : <span className="text-slate-300">—</span>}</td>)}</tr>)}</tbody>
            </table>
            <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">You are signed in as <b>{user?.name}</b> ({humanize(user?.role)}).</div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center gap-2 font-semibold"><KeyRound className="size-4 text-brand-600" /> Security controls</div>
            <ul className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
              {["OAuth2 bearer tokens (JWT), SSO-ready (OIDC / Entra ID / Okta)", "Credentials encrypted at rest (AES) in the secret store", "Secrets never stored in pipeline metadata or shown again", "Tenant isolation on every table and file", "Separate development / staging / production targets", "Full audit trail of changes, deployments and sign-ins"].map((x) => (
                <li key={x} className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />{x}</li>
              ))}
            </ul>
          </Card>
        </TabsContent>
        {isAdmin && (
          <TabsContent value="audit" className="mt-6">
            <Card className="overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-500"><th className="px-5 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Action</th><th className="px-3 py-2 font-medium">Resource</th><th className="px-5 py-2 font-medium">Details</th></tr></thead>
                <tbody>{(audit ?? []).map((a) => <tr key={a.id} className="border-b border-slate-50"><td className="whitespace-nowrap px-5 py-2 text-slate-500">{timeAgo(a.at)}</td><td className="px-3 py-2"><code className="text-xs">{a.action}</code></td><td className="px-3 py-2 font-mono text-xs text-slate-500">{a.resource}</td><td className="max-w-md truncate px-5 py-2 text-xs text-slate-500">{Object.entries(a.details).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</td></tr>)}</tbody>
              </table>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
