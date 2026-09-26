"""Contextual AI assistant. Answers are grounded in the current pipeline's metadata, profile and configuration.
It can *propose* a transformation (structured, validated) that the user applies with one click — never code."""
from __future__ import annotations

import json
import re
from typing import Any

import polars as pl

from ..engine.health import estimate_cost
from ..engine.metadata import PipelineMetadata, TransformStep
from ..transforms.executor import preview_step
from ..transforms.library import describe_step
from . import llm, policy

SUGGESTIONS = {
    "source": ["What did you detect in my file?", "Which datasets should I include?"],
    "analyze": ["Why is Customer_ID considered the primary key?", "Show me which columns contain duplicates.", "Which columns contain personal data?"],
    "transform": ["Why are you recommending this transformation?", "What happens if I remove these records?", "Create a customer age column."],
    "configure": ["Why did you choose Auto Loader?", "How often should this pipeline run?"],
    "design": ["Why do I need Bronze, Silver and Gold?", "What is customer_360?"],
    "review": ["Is my pipeline ready to deploy?", "How much will this cost?"],
    "monitor": ["Why did the volume drop?", "Is my data fresh?"],
}


def _words(q: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_]+", q.lower()))


def _dataset_for(meta: PipelineMetadata, q: str, dataset_id: str | None) -> str | None:
    if dataset_id and meta.dataset(dataset_id):
        return dataset_id
    ql = q.lower()
    for d in meta.selected_datasets():
        if d.name.lower() in ql or any(w in ql for w in re.findall(r"[a-z]{4,}", d.name.lower())):
            return d.id
    ds = meta.selected_datasets()
    return ds[0].id if ds else None


def _find_column(meta: PipelineMetadata, q: str, ds_id: str | None) -> str | None:
    prof = meta.analysis.profiles.get(ds_id or "", {})
    ql = q.lower().replace(" ", "_")
    cols = sorted((c["name"] for c in prof.get("columns", [])), key=len, reverse=True)
    for c in cols:
        if c.lower() in ql or c.lower().replace("_", " ") in q.lower():
            return c
    return None


def answer(meta: PipelineMetadata, question: str, *, page: str | None = None, dataset_id: str | None = None,
           recommendation_id: str | None = None, runtime: Any = None) -> dict[str, Any]:
    q = question.strip()
    ql = q.lower()
    w = _words(q)
    ds_id = _dataset_for(meta, q, dataset_id)
    ds = meta.dataset(ds_id) if ds_id else None
    prof = meta.analysis.profiles.get(ds_id or "", {})
    facts: list[str] = []
    action: dict | None = None
    text = ""

    if llm.is_enabled():
        ctx = {"page": page, "dataset": ds.name if ds else None, "profile_summary": {k: prof.get(k) for k in ("row_count", "duplicate_rows", "primary_key_candidates", "quality")},
               "columns": [{k: c.get(k) for k in ("name", "semantic_type", "null_pct", "invalid_count", "pattern_count")} for c in prof.get("columns", [])],
               "recommendations": [r.model_dump(include={"title", "reason", "explanation", "status"}) for r in meta.recommendations[:20]],
               "transformations": [describe_step(t.type, t.params) for t in meta.transformations], "ingestion": meta.ingestion.model_dump(include={"engine", "rationale", "mode", "frequency"}),
               "lakehouse": [t.name for t in meta.lakehouse.tables]}
        res = llm.answer(q, ctx)
        if res:
            if res.suggested_transform_type and ds_id:
                try:
                    params = json.loads(res.suggested_params_json or "{}")
                    cols = runtime.columns_after(ds_id) if runtime else [c["name"] for c in prof.get("columns", [])]
                    if not policy.validate_transform(res.suggested_transform_type, params, cols):
                        action = {"kind": "add_transform", "dataset_id": ds_id, "transform": {"type": res.suggested_transform_type, "params": params},
                                  "label": describe_step(res.suggested_transform_type, params)}
                except json.JSONDecodeError:
                    pass
            return {"answer": res.answer, "facts": [], "action": action, "suggestions": SUGGESTIONS.get(page or "", []), "provider": "llm"}

    rec = next((r for r in meta.recommendations if r.id == recommendation_id), None)
    if not rec and ("why" in w and ("recommend" in ql or "suggest" in ql)):
        scored = sorted(meta.recommendations, key=lambda r: -len(_words(r.title) & w))
        rec = scored[0] if scored and len(_words(scored[0].title) & w) >= 1 else (meta.recommendations[0] if meta.recommendations else None)

    # ---- create a column
    if w & {"create", "add", "make", "derive", "calculate"} and "column" in w or ("age" in w and w & {"create", "add", "calculate"}):
        cols = [c["name"] for c in prof.get("columns", [])]
        dob = next((c["name"] for c in prof.get("columns", []) if c["semantic_type"] == "date_of_birth"), None)
        if "age" in w and dob:
            params = {"column": dob, "output": "customer_age" if "customer" in w else "age"}
            action = {"kind": "add_transform", "dataset_id": ds_id, "transform": {"type": "calculate_age", "params": params}, "label": f"Create {params['output']} from {dob}"}
            text = f"I can create **{params['output']}** as the number of whole years between **{dob}** and today. Dates in mixed formats are parsed automatically."
        elif "full" in w and "name" in w:
            first = next((c for c in cols if "first" in c.lower()), None)
            last = next((c for c in cols if "last" in c.lower() and "name" in c.lower()), None)
            if first and last:
                action = {"kind": "add_transform", "dataset_id": ds_id, "transform": {"type": "merge_columns", "params": {"columns": [first, last], "separator": " ", "output": "full_name"}},
                          "label": f"Create full_name from {first} + {last}"}
                text = f"I can combine **{first}** and **{last}** into a new **full_name** column."
        elif w & {"year", "month", "quarter"}:
            col = _find_column(meta, q, ds_id) or next((c["name"] for c in prof.get("columns", []) if c["semantic_type"] in ("date", "timestamp")), None)
            part = next(p for p in ("year", "month", "quarter") if p in w)
            if col:
                action = {"kind": "add_transform", "dataset_id": ds_id, "transform": {"type": "extract_date_part", "params": {"column": col, "part": part}},
                          "label": f"Extract {part} from {col}"}
                text = f"I can extract the **{part}** from **{col}** into a new column."
        if not text:
            text = ("I can build most columns without code. Try: *'Create a customer age column'*, *'Create a full name column'* or *'Add order year'*. "
                    "For custom logic, open **Formula column** in the Transformation Studio.")
        if action and runtime:
            cols_now = runtime.columns_after(ds_id)
            if policy.validate_transform(action["transform"]["type"], action["transform"]["params"], cols_now):
                action = None
                text += "\n\nThe required column isn't available at the end of the current steps (it may have been renamed)."
    # ---- why recommendation
    elif rec:
        text = f"**{rec.title}**\n\n{rec.explanation or rec.reason}\n\n**Why:** {rec.reason}\n\n**Expected benefit:** {rec.expected_benefit}"
        facts = [f"Impact: {rec.impact}", f"Confidence: {rec.confidence * 100:.0f}%"] + ([f"Affects {rec.affected_rows:,} records"] if rec.affected_rows else [])
    # ---- primary key
    elif "primary" in w or ("key" in w and "why" in w):
        pk = (prof.get("primary_key_candidates") or [None])[0]
        if pk:
            c = next((c for c in prof["columns"] if c["name"] == pk["column"]), {})
            text = (f"**{pk['column']}** is the most likely primary key ({pk['confidence'] * 100:.1f}% confidence) for **{ds.name}**:\n\n"
                    f"- {pk['uniqueness_pct']}% of its values are unique\n- {100 - c.get('null_pct', 0):.1f}% of records have a value\n"
                    f"- Its name and position follow identifier conventions\n" + (f"- {pk['duplicates']:,} duplicate values remain — that's why removing duplicates is recommended." if pk["duplicates"] else ""))
            others = prof["primary_key_candidates"][1:]
            if others:
                facts.append("Other candidates: " + ", ".join(f"{o['column']} ({o['confidence'] * 100:.0f}%)" for o in others))
        else:
            text = "I couldn't find a column that is unique and complete enough to be a primary key. Consider combining columns or removing duplicates first."
    # ---- duplicates
    elif w & {"duplicate", "duplicates", "duplicated", "dupes"}:
        lines = []
        for d in meta.selected_datasets():
            p = meta.analysis.profiles.get(d.id)
            if not p:
                continue
            pk = (p.get("primary_key_candidates") or [None])[0]
            dup_cols = [c for c in p["columns"] if c.get("duplicate_values") and c["semantic_type"] in ("identifier", "email", "phone") and c.get("unique_pct", 0) > 80]
            lines.append(f"**{d.name}** — {p['duplicate_rows']:,} exact duplicate rows" + (f"; {pk['duplicates']:,} repeated {pk['column']} values" if pk and pk["duplicates"] else ""))
            for c in dup_cols[:4]:
                lines.append(f"  - {c['name']}: {c['duplicate_values']:,} repeated values ({c['unique_pct']}% unique)")
        if runtime and ds_id and prof.get("primary_key_candidates"):
            key = prof["primary_key_candidates"][0]["column"]
            df = runtime.raw(ds_id)
            sample = df.filter(pl.col(key).is_duplicated()).group_by(key).len().sort("len", descending=True).head(5)
            facts = [f"{k}: {n} copies" for k, n in sample.rows()]
        text = "Here's where duplicates are:\n\n" + "\n".join(lines) if lines else "No duplicates were found in the analyzed data."
    # ---- what happens if I remove
    elif w & {"remove", "delete", "drop"} and ("happens" in w or "what" in w or "if" in w):
        target = rec or next((r for r in meta.recommendations if r.destructive and r.status == "pending" and (not ds_id or r.dataset_id == ds_id)), None)
        if target and runtime:
            t = target.action["transform"]
            draft = TransformStep(type=t["type"], dataset_id=target.dataset_id, params=t.get("params") or {})
            pv = preview_step(runtime.raw(target.dataset_id), runtime.steps_for(target.dataset_id), None, runtime.context(), draft=draft, row_limit=10)
            b, a = pv["before"]["metrics"], pv["after"]["metrics"]
            text = (f"If you apply **{target.title}**:\n\n- Records: {b['rows']:,} → {a['rows']:,} ({b['rows'] - a['rows']:,} removed)\n"
                    f"- Duplicates: {b['duplicates']:,} → {a['duplicates']:,}\n- Quality score: {b['quality_score']}% → {a['quality_score']}%\n\n"
                    "Removed records are **not lost** — Bronze keeps the full raw copy, so you can always reprocess.")
        else:
            text = "Removing records only affects Silver and Gold. The Bronze layer keeps an untouched copy of everything, so nothing is permanently lost."
    # ---- ingestion
    elif w & {"auto", "loader", "ingestion", "ingest", "lakeflow", "cdc", "incremental"} or ("why" in w and "choose" in w):
        ing = meta.ingestion
        text = f"**{ing.engine.replace('_', ' ').title()}** was chosen. {ing.rationale}\n\nMode: **{ing.mode}** · Schedule: **{ing.frequency.replace('_', ' ')}** · Schema changes: **{ing.schema_evolution.replace('_', ' ')}**."
        facts = ing.notes
    # ---- quality
    elif w & {"quality", "score", "invalid"}:
        if prof:
            qd = prof["quality"]
            text = (f"**{ds.name}** scores **{qd['score']}%** before transformations:\n\n- Completeness {qd['completeness']}%\n- Validity {qd['validity']}%\n"
                    f"- Uniqueness {qd['uniqueness']}%\n- Consistency {qd['consistency']}%\n\nApplying the recommended transformations typically raises it above 95%.")
            facts = [f"{c['name']}: {c['invalid_count']} invalid" for c in prof["columns"] if c.get("invalid_count")][:5]
    # ---- pii
    elif w & {"pii", "personal", "sensitive", "gdpr", "privacy", "mask"}:
        items = meta.governance.pii
        text = ("These columns contain personal or sensitive data and are protected with Unity Catalog:\n\n" +
                "\n".join(f"- **{p.column}** ({p.category.replace('_', ' ')}) → {p.action}" for p in items)) if items else "No personal data was detected."
    # ---- missing values
    elif w & {"missing", "null", "empty", "blank"}:
        cols = [c for c in prof.get("columns", []) if c.get("null_pct", 0) > 0]
        cols.sort(key=lambda c: -c["null_pct"])
        text = "Columns with missing values:\n\n" + "\n".join(f"- **{c['name']}**: {c['null_pct']}% ({c['null_count']:,})" for c in cols[:10]) if cols else "No missing values found."
    # ---- cost
    elif w & {"cost", "price", "expensive", "dbu", "spend"}:
        c = estimate_cost(meta)
        text = (f"Estimated **${c['monthly_total_usd']:,.2f}/month**: compute ${c['compute_usd']:,.2f} ({c['dbus_per_month']} DBUs over {c['runs_per_month']} runs) "
                f"and storage ${c['storage_usd']:,.2f}.\n\n{c['assumptions']}")
    # ---- lakehouse
    elif w & {"bronze", "silver", "gold", "lakehouse", "medallion", "customer_360", "360"}:
        text = "**Medallion architecture**\n\n- **Bronze** — raw, untouched copy for audit and replay\n- **Silver** — cleaned, validated tables (one per business entity)\n- **Gold** — business-ready models\n\n" + \
               "\n".join(f"- {r}" for r in meta.lakehouse.rationale)
        facts = [f"{t.layer.title()}: {t.name}" for t in meta.lakehouse.tables if t.layer == "gold"]
    # ---- ready?
    elif w & {"ready", "deploy", "readiness"}:
        hc = meta.health_check
        if hc.ran_at:
            issues = [c for c in hc.checks if c["status"] in ("fail", "warn")]
            text = f"Readiness score **{hc.score}/100** — {'ready to deploy ✓' if hc.ready else 'not ready yet'}.\n\n" + "\n".join(f"- {c['label']}: {c['message']}" for c in issues)
        else:
            text = "Run the **AI Pipeline Readiness Check** on the Review step and I'll tell you exactly what's missing."
    else:
        n_ds = len(meta.selected_datasets())
        text = (f"This pipeline has {n_ds} dataset(s), {sum(1 for t in meta.transformations if t.enabled)} transformation steps and "
                f"{sum(1 for r in meta.recommendations if r.status == 'pending')} pending recommendations. Ask me about duplicates, missing values, "
                "primary keys, quality, personal data, ingestion or cost — or ask me to create a column.")
    return {"answer": text, "facts": facts, "action": action, "suggestions": SUGGESTIONS.get(page or "", SUGGESTIONS["transform"]), "provider": "heuristic"}
