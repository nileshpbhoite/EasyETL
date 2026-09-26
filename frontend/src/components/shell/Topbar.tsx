"use client";

import { Bell, ChevronDown, CircleHelp, Library, LogOut, Menu, Plus, Search, Sparkles, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, clearSession, getStoredUser } from "@/lib/api";
import { useUI } from "@/lib/store";
import type { Alert, PipelineSummary } from "@/lib/types";
import { cn, humanize, timeAgo } from "@/lib/utils";
import { Button, Select } from "@/components/ui";

interface SearchItem {
  type: "pipeline" | "table";
  label: string;
  sub: string;
  href: string;
}

function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [active, setActive] = useState(0);
  const loaded = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const load = async () => {
    if (loaded.current) return;
    loaded.current = true;
    try {
      const [pipelines, catalog] = await Promise.all([
        api.get<PipelineSummary[]>("/api/pipelines"),
        api.get<{ name: string; schemas: { name: string; tables: { name: string; fqn: string; description: string; pipeline_id: string }[] }[] }[]>("/api/catalog"),
      ]);
      const out: SearchItem[] = pipelines.map((p) => ({ type: "pipeline", label: p.name, sub: `${p.source_label} · ${humanize(p.status)}`, href: `/pipelines/${p.id}` }));
      for (const c of catalog) for (const s of c.schemas) for (const t of s.tables) out.push({ type: "table", label: t.fqn, sub: t.description, href: `/catalog?table=${encodeURIComponent(t.fqn)}` });
      setItems(out);
    } catch {
      loaded.current = false;
    }
  };

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.slice(0, 6);
    return items.filter((i) => (i.label + " " + i.sub).toLowerCase().includes(t)).slice(0, 8);
  }, [q, items]);

  const go = (item: SearchItem) => {
    setOpen(false);
    setQ("");
    router.push(item.href);
  };

  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onFocus={() => {
          setOpen(true);
          void load();
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
          if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          if (e.key === "Enter" && results[active]) go(results[active]);
          if (e.key === "Escape") inputRef.current?.blur();
        }}
        placeholder="Search pipelines, sources, or ask AI…"
        aria-label="Global search"
        className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-14 shadow-sm text-sm placeholder:text-slate-400 focus:border-brand-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white px-1.5 text-[10px] font-medium text-slate-400">⌘K</kbd>
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-11 z-40 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lift animate-fade-in">
          {results.map((r, i) => (
            <button
              key={r.href + i}
              onMouseDown={() => go(r)}
              className={cn("flex w-full items-center gap-3 px-3 py-2 text-left", i === active ? "bg-brand-50" : "hover:bg-slate-50")}
            >
              <div className="flex size-7 items-center justify-center rounded-md bg-slate-100 text-slate-500">{r.type === "pipeline" ? <Workflow className="size-3.5" /> : <Library className="size-3.5" />}</div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-800">{r.label}</div>
                <div className="truncate text-xs text-slate-500">{r.sub}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  useEffect(() => {
    api.get<{ insights: Alert[] }>("/api/dashboard").then((d) => setAlerts(d.insights.filter((i) => i.kind !== "summary"))).catch(() => undefined);
  }, []);
  const count = alerts.filter((a) => a.severity !== "info").length;
  return (
    <div className="relative">
      <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} aria-label="Notifications" className="relative">
        <Bell />
        {count > 0 && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">{count}</span>}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-40 w-96 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lift animate-fade-in">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Notifications</div>
            <div className="max-h-96 overflow-y-auto scrollbar-thin">
              {alerts.length === 0 && <div className="px-4 py-8 text-center text-sm text-slate-500">You're all caught up.</div>}
              {alerts.map((a) => (
                <Link key={a.id} href={a.pipeline_id ? `/monitoring?pipeline=${a.pipeline_id}` : "/monitoring"} onClick={() => setOpen(false)} className="flex gap-3 border-b border-slate-50 px-4 py-3 hover:bg-slate-50">
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", a.severity === "critical" ? "bg-rose-500" : a.severity === "warning" ? "bg-amber-500" : "bg-sky-500")} />
                  <div className="min-w-0">
                    <div className="text-sm text-slate-800">{a.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {a.pipeline_name} {a.detected_at && `· ${timeAgo(a.detected_at)}`}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UserMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<ReturnType<typeof getStoredUser>>(null);
  useEffect(() => setUser(getStoredUser()), []);
  const initials = (user?.name ?? "U").split(" ").map((p) => p[0]).join("").slice(0, 2);
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-slate-100" aria-label="User menu">
        <div className="flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-ai-600 text-xs font-bold text-white ring-2 ring-white">{initials}</div>
        <ChevronDown className="hidden size-3.5 text-slate-400 2xl:block" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-40 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lift animate-fade-in">
            <div className="px-3 py-2">
              <div className="text-sm font-semibold">{user?.name}</div>
              <div className="text-xs text-slate-500">{user?.email}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {user?.permissions.map((p) => (
                  <span key={p} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                    {humanize(p)}
                  </span>
                ))}
              </div>
            </div>
            <button
              onClick={() => {
                clearSession();
                router.push("/login");
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Topbar({ onMenu }: { onMenu?: () => void } = {}) {
  const path = usePathname();
  const { openAssistant, environment, setEnvironment } = useUI();
  const inWizard = /^\/pipelines\/[a-z0-9]{8,}/.test(path);

  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200/60 bg-white/80 px-4 backdrop-blur-md md:px-6">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" onClick={onMenu}><Menu /></Button>
      <GlobalSearch />
      <button
        onClick={() => openAssistant(inWizard ? {} : { pipelineId: undefined, page: path.split("/")[1] || "home" })}
        className="hidden h-10 items-center gap-1.5 rounded-xl bg-gradient-to-r from-ai-50 to-brand-50 px-3.5 text-[13px] font-semibold text-ai-700 ring-1 ring-ai-200 transition-all hover:ring-ai-300 sm:flex"
      >
        <Sparkles className="size-4" /> Ask AI
      </button>
      <div className="ml-auto flex items-center gap-1.5">
        <Select
          value={environment}
          onChange={setEnvironment}
          className="hidden w-40 xl:block"
          options={[
            { value: "development", label: "● Development" },
            { value: "staging", label: "● Staging" },
            { value: "production", label: "● Production" },
          ]}
        />
        <Notifications />
        <Link href="/help">
          <Button variant="ghost" size="icon" aria-label="Help">
            <CircleHelp />
          </Button>
        </Link>
        {!inWizard && path !== "/" && path !== "/pipelines/new" && (
          <Link href="/pipelines/new" className="ml-1">
            <Button variant="primary"><Plus /> New Pipeline</Button>
          </Link>
        )}
        <UserMenu />
      </div>
    </header>
  );
}
