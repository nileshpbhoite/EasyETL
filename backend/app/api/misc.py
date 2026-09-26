"""Transformation library, templates, data catalog, dashboard, global assistant, settings and audit."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import or_, select

from ..core.errors import FriendlyError
from ..core.models import AuditLog, Connection, Pipeline, PipelineRun, Template
from ..core.security import audit
from ..engine import service
from ..engine.health import estimate_cost
from ..engine.metadata import PipelineMetadata
from ..monitoring import service as monitoring
from ..transforms import expressions
from ..transforms.library import CATEGORIES, list_specs
from ..transforms.library import to_snake
from .common import DB, Admin, Editor, User, iso, pipeline_out

router = APIRouter(prefix="/api", tags=["platform"])


# ------------------------------------------------------------------ transformation library
@router.get("/transforms")
def transforms(user: User):
    return {"categories": [{"id": c, "label": l, "icon": i} for c, l, i in CATEGORIES], "transforms": list_specs(),
            "functions": [{"name": k, **v} for k, v in expressions.FUNCTIONS.items()], "operators": sorted(expressions.OPS)}


# ------------------------------------------------------------------ templates
def _tpl(t: Template) -> dict:
    cfg = t.config or {}
    return {"id": t.id, "name": t.name, "description": t.description, "category": t.category, "source_hint": t.source_hint, "builtin": t.tenant_id is None,
            "uses": t.uses, "created_at": iso(t.created_at), "transform_count": len(cfg.get("transformations", [])),
            "highlights": cfg.get("highlights", []), "config": cfg}


@router.get("/templates")
def templates(db: DB, user: User):
    rows = db.scalars(select(Template).where(or_(Template.tenant_id.is_(None), Template.tenant_id == user.tenant_id)).order_by(Template.tenant_id.is_(None).desc(), Template.name)).all()
    return [_tpl(t) for t in rows]


@router.delete("/templates/{template_id}")
def delete_template(template_id: str, db: DB, user: Editor):
    t = db.get(Template, template_id)
    if not t or t.tenant_id != user.tenant_id:
        raise FriendlyError("Can't delete", "Built-in templates can't be deleted.", status_code=403)
    db.delete(t)
    audit(db, user, "template.delete", template_id)
    db.commit()
    return {"ok": True}


class ImportTemplate(BaseModel):
    name: str
    description: str = ""
    category: str = "Imported"
    config: dict


@router.post("/templates/import")
def import_template(body: ImportTemplate, db: DB, user: Editor):
    allowed = {"transformations", "ingestion", "lakehouse", "governance", "quality_rule_types", "highlights"}
    cfg = {k: v for k, v in body.config.items() if k in allowed}
    from ..ai.policy import _scan

    problems = _scan(cfg)
    if problems:
        raise FriendlyError("Template rejected", " ".join(problems))
    t = Template(tenant_id=user.tenant_id, name=body.name, description=body.description, category=body.category, config=cfg, created_by=user.id)
    db.add(t)
    db.commit()
    return _tpl(t)


# ------------------------------------------------------------------ data catalog
def _layer_schema(meta: PipelineMetadata, layer: str) -> str:
    return {"bronze": meta.lakehouse.bronze_schema, "silver": meta.lakehouse.silver_schema, "gold": meta.lakehouse.gold_schema}[layer]


@router.get("/catalog")
def catalog(db: DB, user: User, q: str = ""):
    rows = db.scalars(select(Pipeline).where(Pipeline.tenant_id == user.tenant_id)).all()
    catalogs: dict[str, dict] = {}
    for row in rows:
        meta = PipelineMetadata(**row.metadata_doc)
        if not meta.lakehouse.tables:
            continue
        cat = catalogs.setdefault(meta.lakehouse.catalog, {"name": meta.lakehouse.catalog, "schemas": {}})
        pii_by_ds = {}
        for p in meta.governance.pii:
            pii_by_ds.setdefault(p.dataset_id, {})[p.column] = p
        renamed = {s.dataset_id for s in meta.transformations if s.type == "standardize_column_names" and s.enabled}
        for t in meta.lakehouse.tables:
            if not t.enabled:
                continue
            schema = cat["schemas"].setdefault(_layer_schema(meta, t.layer), {"name": _layer_schema(meta, t.layer), "layer": t.layer, "tables": []})
            ds_id = t.source_datasets[0] if t.source_datasets else None
            prof = meta.analysis.profiles.get(ds_id or "", {})
            cols = []
            for c in prof.get("columns", []):
                name = to_snake(c["name"]) if (t.layer != "bronze" and ds_id in renamed) else c["name"]
                pii = pii_by_ds.get(ds_id, {}).get(c["name"])
                cols.append({"name": name, "type": "string" if t.layer == "bronze" else _logical(c), "description": _col_desc(c),
                             "pii": pii.category if pii else None, "protection": pii.action if pii and t.layer != "bronze" else None,
                             "null_pct": c.get("null_pct"), "semantic_type": c["semantic_type"]})
            if t.layer == "gold":
                cols = [{"name": k, "type": "string", "description": "Business key"} for k in t.primary_key] + [
                    {"name": f"{r['entity']}_count" if isinstance(r, dict) else "metric", "type": "bigint", "description": "Aggregated metric"}
                    for r in (t.gold_logic.get("related") or [])] + ([{"name": "period", "type": "date", "description": "Reporting period"},
                                                                      {"name": "records", "type": "bigint", "description": "Record count"}] if t.gold_logic.get("type") == "time_summary" else [])
            quality = prof.get("quality", {}).get("score")
            if t.layer != "bronze" and ds_id in meta.analysis.quality_after:
                quality = meta.analysis.quality_after[ds_id]["quality_score"]
            table = {"name": t.name, "fqn": f"{meta.lakehouse.catalog}.{_layer_schema(meta, t.layer)}.{t.name}", "layer": t.layer,
                     "description": t.description, "columns": cols, "row_count": (meta.dataset(ds_id).row_count if ds_id and meta.dataset(ds_id) else None),
                     "quality_score": round(quality, 1) if quality is not None else None, "pii_count": sum(1 for c in cols if c.get("pii")),
                     "source": meta.source.name, "pipeline_id": row.id, "pipeline_name": row.name, "primary_key": t.primary_key, "cluster_by": t.cluster_by,
                     "last_updated": iso(row.updated_at), "status": "live" if meta.deployment.status == "deployed" else "designed",
                     "tags": meta.governance.tags, "owner": meta.governance.data_owner}
            if q and q.lower() not in (table["fqn"] + " " + t.description + " " + " ".join(c["name"] for c in cols)).lower():
                continue
            schema["tables"].append(table)
    out = []
    for c in catalogs.values():
        schemas = sorted(c["schemas"].values(), key=lambda s: ["bronze", "silver", "gold"].index(s["layer"]) if s["layer"] in ("bronze", "silver", "gold") else 9)
        schemas = [s for s in schemas if s["tables"]]
        if schemas:
            out.append({"name": c["name"], "schemas": schemas})
    return out


def _logical(c: dict) -> str:
    return {"integer": "bigint", "decimal": "decimal(38,6)", "currency": "decimal(18,2)", "percentage": "double", "boolean": "boolean", "date": "date",
            "date_of_birth": "date", "timestamp": "timestamp", "nested": "struct"}.get(c["semantic_type"], "string")


def _col_desc(c: dict) -> str:
    st = c["semantic_type"].replace("_", " ")
    return f"{st.title()} · {100 - c.get('null_pct', 0):.0f}% complete" + (f" · {c['distinct_count']:,} distinct" if c.get("distinct_count") else "")


# ------------------------------------------------------------------ dashboard
@router.get("/dashboard")
def dashboard(db: DB, user: User):
    rows = db.scalars(select(Pipeline).where(Pipeline.tenant_id == user.tenant_id).order_by(Pipeline.updated_at.desc())).all()
    now = datetime.now(timezone.utc)
    active = failed = 0
    records_24h = 0
    qualities, freshness = [], []
    cost = 0.0
    recent = []
    insights = []
    sources = set()
    for row in rows:
        meta = PipelineMetadata(**row.metadata_doc)
        if meta.source.connector:
            sources.add((meta.source.connector, meta.source.connection_id or row.id))
        monitoring.ensure_runs(db, row, meta)
        runs = monitoring.runs_for(db, row.id, limit=200)
        summary = monitoring.summary(meta, row, runs) if runs else {}
        if meta.deployment.status == "deployed":
            if summary.get("status") == "failed":
                failed += 1
            elif summary.get("status") == "running":
                active += 1
            records_24h += summary.get("records_24h", 0)
            if summary.get("quality_score"):
                qualities.append(summary["quality_score"])
            if summary.get("freshness_minutes") is not None:
                freshness.append(summary["freshness_minutes"])
            cost += estimate_cost(meta)["monthly_total_usd"]
            for a in monitoring.detect_anomalies(meta, runs, paused=row.status == "paused")[:2]:
                insights.append({**a, "pipeline_id": row.id, "pipeline_name": row.name})
        elif meta.recommendations:
            pending = sum(1 for r in meta.recommendations if r.status == "pending")
            if pending:
                insights.append({"id": f"recs-{row.id}", "kind": "recommendations", "severity": "info", "pipeline_id": row.id, "pipeline_name": row.name,
                                 "title": f"{pending} AI recommendations are waiting for review in {row.name}.", "detail": "", "recommendation": "Open the pipeline to review them."})
        p = pipeline_out(row, meta, full=False)
        p["last_run"] = monitoring.run_dict(runs[-1]) if runs else None
        p["next_run"] = summary.get("next_run")
        p["records_processed"] = sum(r.records_ingested for r in runs) if runs else 0
        recent.append(p)
    attention = sum(1 for i in insights if i["severity"] in ("critical", "warning"))
    if attention:
        insights.insert(0, {"id": "attention", "kind": "summary", "severity": "warning", "title": f"{attention} pipeline issue{'s' if attention != 1 else ''} require attention.",
                            "detail": "", "recommendation": "Review the alerts below."})
    n_conn = db.query(Connection).filter(Connection.tenant_id == user.tenant_id).count()
    return {
        "metrics": {"active_pipelines": active, "total_pipelines": len(rows), "data_sources": max(len(sources), n_conn), "records_24h": records_24h,
                    "quality_score": round(sum(qualities) / len(qualities), 1) if qualities else None, "failed_pipelines": failed,
                    "freshness_minutes": round(max(freshness), 0) if freshness else None, "estimated_monthly_cost": round(cost, 2)},
        "recent_pipelines": recent[:8], "insights": insights[:8], "generated_at": now.isoformat(),
    }


# ------------------------------------------------------------------ global assistant (no pipeline selected)
class GlobalAsk(BaseModel):
    question: str


@router.post("/assistant")
def global_assistant(body: GlobalAsk, db: DB, user: User):
    rows = db.scalars(select(Pipeline).where(Pipeline.tenant_id == user.tenant_id)).all()
    ql = body.question.lower()
    deployed = [r for r in rows if r.metadata_doc.get("deployment", {}).get("status") == "deployed"]
    if any(w in ql for w in ("fail", "attention", "problem", "issue", "alert")):
        lines = []
        for r in deployed:
            meta = PipelineMetadata(**r.metadata_doc)
            for a in monitoring.detect_anomalies(meta, monitoring.runs_for(db, r.id))[:2]:
                lines.append(f"- **{r.name}** — {a['title']} {a['recommendation']}")
        text = "Here's what needs attention:\n\n" + "\n".join(lines) if lines else "All deployed pipelines are healthy. 🎉"
    elif "how" in ql and ("start" in ql or "create" in ql or "begin" in ql):
        text = ("1. Click **New Pipeline**\n2. Drop a file (or connect an application/database)\n3. Review what AI found and click **Apply All Recommendations**\n"
                "4. Accept the recommended ingestion and Lakehouse design\n5. Run the readiness check and click **Deploy to Databricks**")
    else:
        text = (f"You have {len(rows)} pipeline(s), {len(deployed)} deployed. Open a pipeline and I'll answer questions about its data — duplicates, "
                "missing values, primary keys, quality, personal data, ingestion choices or cost.")
    return {"answer": text, "facts": [], "action": None, "suggestions": ["Which pipelines need attention?", "How do I start?"], "provider": "heuristic"}


# ------------------------------------------------------------------ settings & audit
@router.get("/settings")
def settings(user: User):
    return service.settings_summary()


@router.get("/audit")
def audit_log(db: DB, user: Admin, limit: int = 100):
    rows = db.scalars(select(AuditLog).where(AuditLog.tenant_id == user.tenant_id).order_by(AuditLog.created_at.desc()).limit(min(limit, 500))).all()
    return [{"id": a.id, "action": a.action, "resource": a.resource, "user_id": a.user_id, "details": a.details, "at": iso(a.created_at)} for a in rows]


@router.get("/runs/recent")
def recent_runs(db: DB, user: User):
    since = datetime.now(timezone.utc) - timedelta(days=1)
    ids = [r.id for r in db.scalars(select(Pipeline).where(Pipeline.tenant_id == user.tenant_id)).all()]
    runs = db.scalars(select(PipelineRun).where(PipelineRun.pipeline_id.in_(ids), PipelineRun.started_at >= since).order_by(PipelineRun.started_at.desc()).limit(50)).all()
    return [monitoring.run_dict(r) | {"pipeline_id": r.pipeline_id} for r in runs]
