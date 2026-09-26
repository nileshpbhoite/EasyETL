"use client";

import { HeroArt } from "@/components/art";

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
      <div className="relative hidden w-[54%] flex-col justify-between overflow-hidden p-12 lg:flex">
        <div className="relative">
          <Logo dark={false} />
        </div>
        <div className="relative max-w-xl">
          <HeroArt className="-mb-6 -ml-6 h-[260px] w-[500px]" />
          <h1 className="text-[42px] font-bold leading-[1.1] text-slate-900">
            Turn <span className="gradient-text italic">any</span> data into insights on Databricks.
          </h1>
          <p className="mt-4 text-[16px] text-slate-600">Turn a messy spreadsheet, API or database into a governed, analytics-ready Lakehouse — in a few clicks, without writing a single line of code.</p>
          <div className="mt-8 grid grid-cols-2 gap-3">
            {[
              { icon: Cable, t: "Connect anything", d: "Files, apps, databases, APIs", c: "from-sky-400 to-brand-500" },
              { icon: Brain, t: "AI understands it", d: "Profiling, insights, best practices", c: "from-ai-400 to-fuchsia-500" },
              { icon: ShieldCheck, t: "Governed by design", d: "Unity Catalog, PII, quality rules", c: "from-emerald-400 to-teal-500" },
              { icon: Rocket, t: "One-click deploy", d: "Bronze → Silver → Gold on Databricks", c: "from-amber-400 to-orange-500" },
            ].map(({ icon: Icon, t, d, c }) => (
              <div key={t} className="glass flex items-center gap-3 rounded-2xl p-3.5">
                <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md", c)}><Icon className="size-5" /></span>
                <div className="min-w-0"><div className="text-sm font-bold text-slate-900">{t}</div><div className="text-xs text-slate-500">{d}</div></div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative text-xs text-slate-500">You choose what you want. EasyETL figures out how to do it.</div>
      </div>
      <div className="flex flex-1 items-center justify-center p-6 md:p-10">
        <div className="glass w-full max-w-md rounded-[28px] p-8 md:p-10">
          <div className="mb-8 lg:hidden">
            <Logo dark={false} />
          </div>
          <h2 className="text-[28px] font-bold text-slate-900">Welcome back 👋</h2>
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
            <div className="mt-8 rounded-2xl bg-gradient-to-br from-brand-50/80 to-ai-50/80 p-4 ring-1 ring-brand-100">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Explore the demo workspace as</div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {cfg.demo_roles.map((r) => (
                  <button
                    key={r.role}
                    onClick={() => demo(r.role)}
                    disabled={!!loading}
                    className={cn("rounded-xl bg-white/90 px-3 py-2 text-left ring-1 ring-slate-200/70 transition-all hover:-translate-y-px hover:ring-brand-300 hover:shadow-card", loading === r.role && "opacity-60")}
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
