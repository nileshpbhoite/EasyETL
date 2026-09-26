"use client";

import { ArrowRight, Brain, Cable, Rocket, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/shell/Logo";
import { Button, ErrorBox, Field, Input } from "@/components/ui";
import { api, ApiError, setSession, type AuthUser } from "@/lib/api";
import { cn, humanize } from "@/lib/utils";

interface SsoConfig {
  providers: { id: string; label: string; enabled: boolean }[];
  demo_login: boolean;
  demo_roles: { role: string; email: string; name: string }[];
}

export default function LoginPage() {
  const router = useRouter();
  const [cfg, setCfg] = useState<SsoConfig | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    api.get<SsoConfig>("/api/auth/sso").then(setCfg).catch((e) => setError(e));
  }, []);

  const finish = (res: { access_token: string; user: AuthUser }) => {
    setSession(res.access_token, res.user);
    router.replace("/");
  };

  const demo = async (role: string) => {
    setLoading(role);
    setError(null);
    try {
      finish(await api.post("/api/auth/demo", { role }));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(null);
    }
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading("password");
    setError(null);
    try {
      const form = new URLSearchParams({ username: email, password });
      const res = await fetch("/api/auth/token", { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data.error?.title ?? "Sign-in failed", data.error?.message ?? "Please try again.");
      finish(data);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex min-h-screen">
      <div className="relative hidden w-[52%] flex-col justify-between overflow-hidden bg-navy-950 p-12 text-white lg:flex">
        <div className="absolute inset-0 opacity-60" style={{ backgroundImage: "radial-gradient(700px 400px at 10% 10%, rgba(99,102,241,.35), transparent 60%), radial-gradient(600px 500px at 90% 90%, rgba(139,92,246,.35), transparent 60%)" }} />
        <div className="relative">
          <Logo />
        </div>
        <div className="relative max-w-lg">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Connect Anything.
            <br />
            Modernize Automatically.
            <br />
            <span className="bg-gradient-to-r from-brand-300 to-ai-300 bg-clip-text text-transparent">Deploy to Databricks.</span>
          </h1>
          <p className="mt-5 text-slate-300">Turn a messy spreadsheet, API or database into a governed, analytics-ready Lakehouse — in a few clicks, without writing a single line of code.</p>
          <div className="mt-10 grid grid-cols-2 gap-4">
            {[
              { icon: Cable, t: "Connect anything", d: "Files, apps, databases, APIs" },
              { icon: Brain, t: "AI understands it", d: "Profiling, insights, best practices" },
              { icon: ShieldCheck, t: "Governed by design", d: "Unity Catalog, PII, quality rules" },
              { icon: Rocket, t: "One-click deploy", d: "Bronze → Silver → Gold on Databricks" },
            ].map(({ icon: Icon, t, d }) => (
              <div key={t} className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <Icon className="size-5 text-brand-300" />
                <div className="mt-2 text-sm font-semibold">{t}</div>
                <div className="text-xs text-slate-400">{d}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative text-xs text-slate-500">You choose what you want. EasyETL figures out how to do it.</div>
      </div>
      <div className="flex flex-1 items-center justify-center bg-white p-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo dark={false} />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Welcome back</h2>
          <p className="mt-1 text-sm text-slate-500">Sign in to your EasyETL workspace.</p>
          <div className="mt-6 space-y-2">
            {cfg?.providers.map((p) => (
              <Button key={p.id} variant="secondary" className="w-full" disabled={!p.enabled} title={p.enabled ? "" : "Configure SSO in Settings → Security"}>
                {p.label}
              </Button>
            ))}
          </div>
          <div className="my-6 flex items-center gap-3 text-xs text-slate-400">
            <div className="h-px flex-1 bg-slate-200" /> or <div className="h-px flex-1 bg-slate-200" />
          </div>
          <form onSubmit={login} className="space-y-4">
            <Field label="Work email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            <Button type="submit" variant="primary" className="w-full" loading={loading === "password"} disabled={!email || !password}>
              Sign in <ArrowRight />
            </Button>
          </form>
          <ErrorBox error={error} className="mt-4" />
          {cfg?.demo_login && (
            <div className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Explore the demo workspace as</div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {cfg.demo_roles.map((r) => (
                  <button
                    key={r.role}
                    onClick={() => demo(r.role)}
                    disabled={!!loading}
                    className={cn("rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition-all hover:border-brand-300 hover:shadow-card", loading === r.role && "opacity-60")}
                  >
                    <div className="text-sm font-medium text-slate-800">{humanize(r.role)}</div>
                    <div className="truncate text-[11px] text-slate-500">{r.name}</div>
                  </button>
                ))}
              </div>
              <div className="mt-3 text-[11px] text-slate-400">Demo password for email sign-in: easyetl-demo</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
