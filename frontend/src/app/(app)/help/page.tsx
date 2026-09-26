import { BookOpen, Brain, Cable, Layers, Rocket, ShieldCheck, Wand } from "lucide-react";
import Link from "next/link";

const TOPICS = [
  { icon: Cable, title: "Connecting data", body: "Drop a file anywhere, or pick an application, database, cloud storage bucket or REST API. EasyETL detects formats, sheets, nested structures, keys, incremental fields and CDC support automatically. Tip: use 'demo' as server, 'easyetl-demo' as bucket or 'demo://recalls' as URL to explore sample sources." },
  { icon: Brain, title: "How AI helps", body: "Profiling is deterministic — row counts, nulls, patterns and invalid values are computed, never guessed. AI interprets those facts and proposes structured recommendations. A policy engine validates every recommendation, and nothing changes until you approve it." },
  { icon: Wand, title: "Transformation Studio", body: "88 no-code transformations across cleaning, types, text, dates, missing values, duplicates, filters, joins, aggregation, pivoting, schema, formulas, enrichment, data quality and PII. Every step has a live Before/After preview with changed cells highlighted. Undo and version history are always available." },
  { icon: Layers, title: "Lakehouse design", body: "Bronze keeps an immutable raw copy, Silver holds cleaned & validated tables per business entity, Gold holds business models such as customer_360. Simple Mode designs it for you; Advanced Mode lets you control catalog, schemas, keys, clustering, partitioning and retention." },
  { icon: ShieldCheck, title: "Governance & quality", body: "Sensitive columns are classified automatically and protected with Unity Catalog column masks, tags and grants. Quality rules become Lakeflow expectations: warn, drop, quarantine or stop the pipeline." },
  { icon: Rocket, title: "Deploying & monitoring", body: "The readiness check verifies source, schema, transformations, quality, ingestion, Lakehouse, governance, security, performance, cost and dependencies — with automatic fixes. One click generates a Databricks bundle and deploys it. AI keeps watching for volume, schema, quality, freshness, performance and cost anomalies." },
];

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-center gap-3"><BookOpen className="size-7 text-brand-600" /><h1 className="text-2xl font-semibold tracking-tight">Help & Documentation</h1></div>
      <p className="mt-2 text-slate-500">You choose what you want. EasyETL figures out how to do it.</p>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {TOPICS.map((t) => (
          <div key={t.title} className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
            <t.icon className="size-5 text-brand-600" />
            <div className="mt-3 font-semibold text-slate-900">{t.title}</div>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{t.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-8 rounded-xl bg-navy-900 p-6 text-white">
        <div className="font-semibold">The journey</div>
        <div className="mt-2 text-sm text-slate-300">Connect anything → AI analyzes → AI explains → AI recommends → you approve → Transformation Studio → Before/After → ingestion → Lakehouse design → governance & quality → health check → one-click deploy → continuous monitoring.</div>
        <Link href="/pipelines/new" className="mt-4 inline-block rounded-lg gradient-primary px-4 py-2 text-sm font-semibold">Create your first pipeline →</Link>
      </div>
    </div>
  );
}
