"""Pipeline service — every UI action becomes a validated change to the metadata document, persisted with
version history (Undo) and audit logging."""
from __future__ import annotations

from typing import Any

import polars as pl
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..ai import heuristics, llm, policy
from ..core.config import get_settings
from ..core.errors import FriendlyError
from ..core.models import Pipeline, PipelineVersion
from ..core.security import CurrentUser, audit
from ..transforms.executor import apply_steps
from ..transforms.library import describe_step, get as get_transform
from .health import run_health_check
from .metadata import (
    GovernanceConfig,
    IngestionConfig,
    LakehouseDesign,
    PipelineMetadata,
    QualityRule,
    Recommendation,
    TableDesign,
    TransformStep,
    now_iso,
)
from .runtime import PipelineRuntime


# ------------------------------------------------------------------ persistence
def load(db: Session, user: CurrentUser, pipeline_id: str) -> tuple[Pipeline, PipelineMetadata]:
    row = db.get(Pipeline, pipeline_id)
    if not row or row.tenant_id != user.tenant_id:
        raise FriendlyError("Pipeline not found", "This pipeline doesn't exist or you don't have access to it.", status_code=404)
    return row, PipelineMetadata(**row.metadata_doc)


def save(db: Session, user: CurrentUser, row: Pipeline, meta: PipelineMetadata, summary: str, *, snapshot: bool = True) -> Pipeline:
    row.metadata_doc = meta.model_dump(mode="json")
    row.name = meta.name
    row.status = _status(meta)
    if snapshot:
        row.version = (row.version or 0) + 1
        db.add(PipelineVersion(pipeline_id=row.id, version=row.version, metadata_doc=row.metadata_doc, change_summary=summary[:500], created_by=user.id))
    audit(db, user, "pipeline.update", row.id, summary=summary)
    db.commit()
    db.refresh(row)
    return row


def _status(meta: PipelineMetadata) -> str:
    if meta.deployment.status == "deployed":
        return "running"
    if meta.deployment.status == "failed":
        return "failed"
    if meta.health_check.ready and "review" in meta.completed_steps:
        return "ready"
    return "draft"


def create(db: Session, user: CurrentUser, name: str, mode: str = "simple", template: dict | None = None, environment: str = "development") -> Pipeline:
    meta = PipelineMetadata(name=name or "Untitled pipeline", mode=mode)  # type: ignore[arg-type]
    if template:
        apply_template(meta, template)
    meta.log("created", template=meta.template_id)
    row = Pipeline(tenant_id=user.tenant_id, name=meta.name, metadata_doc=meta.model_dump(mode="json"), created_by=user.id, environment=environment, version=0)
    db.add(row)
    db.flush()
    return save(db, user, row, meta, "Pipeline created")


def undo(db: Session, user: CurrentUser, row: Pipeline) -> PipelineMetadata:
    versions = db.scalars(select(PipelineVersion).where(PipelineVersion.pipeline_id == row.id).order_by(PipelineVersion.version.desc()).limit(2)).all()
    if len(versions) < 2:
        raise FriendlyError("Nothing to undo", "This is the earliest version of the pipeline.")
    prev = versions[1]
    meta = PipelineMetadata(**prev.metadata_doc)
    meta.log("undo", restored_version=prev.version, undone=versions[0].change_summary)
    save(db, user, row, meta, f"Undo: {versions[0].change_summary}")
    return meta


# ------------------------------------------------------------------ templates
def apply_template(meta: PipelineMetadata, template: dict) -> None:
    cfg = template.get("config", {})
    meta.template_id = template.get("id")
    if cfg.get("ingestion"):
        meta.ingestion = IngestionConfig(**{**meta.ingestion.model_dump(), **cfg["ingestion"]})
    if cfg.get("lakehouse"):
        lh = cfg["lakehouse"]
        meta.lakehouse = LakehouseDesign(**{**meta.lakehouse.model_dump(), **{k: v for k, v in lh.items() if k != "tables"}})
    if cfg.get("governance"):
        meta.governance = GovernanceConfig(**{**meta.governance.model_dump(), **{k: v for k, v in cfg["governance"].items() if k != "pii"}})
    meta.history.append({"at": now_iso(), "event": "template_applied", "template": template.get("name"),
                         "transform_types": [t.get("type") for t in cfg.get("transformations", [])]})
    # Transformation patterns are re-bound to the new source's columns after analysis (see bind_template_steps).
    meta.source.config.setdefault("_template_transform_patterns", cfg.get("transformations", []))


def bind_template_steps(meta: PipelineMetadata, rt: PipelineRuntime) -> int:
    """Re-apply a template's transformation patterns to matching columns of the newly connected source."""
    patterns = meta.source.config.pop("_template_transform_patterns", None) or []
    added = 0
    for ds in meta.selected_datasets():
        cols = rt.columns_after(ds.id)
        lower = {c.lower(): c for c in cols}
        for pat in patterns:
            params = dict(pat.get("params") or {})
            ok = True
            if isinstance(params.get("column"), str):
                match = lower.get(params["column"].lower())
                ok = bool(match)
                if match:
                    params["column"] = match
            if isinstance(params.get("order_by"), str):
                match = lower.get(params["order_by"].lower())
                if match:
                    params["order_by"] = match
                else:
                    params.pop("order_by")
            if isinstance(params.get("columns"), list):
                params["columns"] = [lower[c.lower()] for c in params["columns"] if c.lower() in lower]
                ok = ok and (bool(params["columns"]) or not pat.get("params", {}).get("columns"))
            if ok and not policy.validate_transform(pat["type"], params, cols):
                meta.transformations.append(TransformStep(type=pat["type"], dataset_id=ds.id, params=params, origin="template",
                                                          label=describe_step(pat["type"], params)))
                added += 1
    return added


def template_from_pipeline(meta: PipelineMetadata) -> dict:
    """Portable configuration: patterns (not bound to one dataset), ingestion, lakehouse and governance settings."""
    return {
        "transformations": [{"type": t.type, "params": t.params} for t in meta.transformations if t.enabled and not get_transform(t.type)[0].multi_dataset],
        "ingestion": meta.ingestion.model_dump(include={"mode", "frequency", "schema_evolution", "file_handling", "compute", "retries", "on_error", "checkpointing"}),
        "lakehouse": meta.lakehouse.model_dump(include={"mode", "catalog", "bronze_schema", "silver_schema", "gold_schema", "retention_days"}),
        "governance": meta.governance.model_dump(include={"unity_catalog", "audit", "lineage", "column_masks", "access_policies", "tags"}),
        "quality_rule_types": sorted({r.rule for r in meta.quality_rules}),
    }


# ------------------------------------------------------------------ analysis
def run_analysis(rt: PipelineRuntime) -> dict[str, Any]:
    meta = rt.meta
    datasets = meta.selected_datasets()
    if not datasets:
        raise FriendlyError("Nothing to analyze", "Select at least one dataset first.")
    frames: dict[str, pl.DataFrame] = {}
    strategies = set()
    for ds in datasets:
        prof = rt.profile(ds.id)
        strategies.add(prof.get("strategy", "local"))
        meta.analysis.profiles[ds.id] = prof
        meta.analysis.entities[ds.id] = heuristics.detect_entity(ds, prof)
        frames[ds.id] = rt.raw(ds.id).head(20_000)
        ds.columns = [{"name": c["name"], "type": c["dtype"], "semantic_type": c["semantic_type"]} for c in prof["columns"]]
        ds.column_count = prof["column_count"]
        if not ds.row_count:
            ds.row_count = prof["row_count"]
    # drop stale profiles of deselected datasets
    for k in list(meta.analysis.profiles):
        if not meta.dataset(k) or not meta.dataset(k).selected:
            meta.analysis.profiles.pop(k, None)
    meta.analysis.relationships = heuristics.detect_relationships(meta, frames)
    meta.analysis.strategy = "databricks" if "databricks" in strategies else "local"
    meta.analysis.profiled_at = now_iso()

    insights = heuristics.build_insights(meta)
    recs = heuristics.recommend_transformations(meta)
    generated_by = "heuristic"
    if llm.is_enabled():
        l_insights, l_recs = llm.analyze(meta)
        if l_insights or l_recs:
            generated_by = "llm+heuristic"
            insights = l_insights + [i for i in insights if i.title not in {x.title for x in l_insights}]
            seen = {(r.dataset_id, (r.action.get("transform") or {}).get("type")) for r in recs}
            recs += [r for r in l_recs if (r.dataset_id, (r.action.get("transform") or {}).get("type")) not in seen]
    columns = {ds.id: [c for c in frames[ds.id].columns if c != "__row_id"] for ds in datasets}
    valid, rejected = policy.filter_valid(recs, meta, columns)
    meta.analysis.insights = insights

    # keep decisions the user already made on equivalent recommendations
    previous = {(r.dataset_id, r.title): r.status for r in meta.recommendations}
    for r in valid:
        r.status = previous.get((r.dataset_id, r.title), "pending")  # type: ignore[assignment]
    meta.recommendations = valid

    # quality rules: refresh AI rules, keep user rules
    ai_rules = heuristics.recommend_quality_rules(meta)
    user_rules = [r for r in meta.quality_rules if r.origin != "ai"]
    prev_ai = {(r.dataset_id, r.column, r.rule): r for r in meta.quality_rules if r.origin == "ai"}
    for r in ai_rules:
        old = prev_ai.get((r.dataset_id, r.column, r.rule))
        if old:
            r.id, r.enabled, r.on_fail = old.id, old.enabled, old.on_fail
    meta.quality_rules = user_rules + ai_rules

    # ingestion / lakehouse / governance recommendations (applied in Simple mode, suggested in Advanced mode)
    ing = heuristics.recommend_ingestion(meta)
    first_time = meta.ingestion.recommended_engine is None
    alternatives = ing.pop("alternatives")
    if first_time or meta.mode == "simple":
        meta.ingestion = IngestionConfig(**ing)
    else:
        meta.ingestion.recommended_engine, meta.ingestion.rationale, meta.ingestion.notes = ing["recommended_engine"], ing["rationale"], ing["notes"]
    design = heuristics.design_lakehouse(meta)
    if not meta.lakehouse.tables or meta.mode == "simple":
        meta.lakehouse.tables = [TableDesign(**t) for t in design["tables"]]
        meta.lakehouse.relationships = design["relationships"]
    meta.lakehouse.rationale = design["rationale"]
    gov = heuristics.recommend_governance(meta)
    prev_pii = {(p.dataset_id, p.column): p.action for p in meta.governance.pii}
    meta.governance = GovernanceConfig(**{**meta.governance.model_dump(), **gov, "catalog": meta.lakehouse.catalog})
    for p in meta.governance.pii:
        if (p.dataset_id, p.column) in prev_pii:
            p.action = prev_pii[(p.dataset_id, p.column)]  # type: ignore[assignment]

    meta.analysis.quality_after = {}
    bound = bind_template_steps(meta, rt) if meta.source.config.get("_template_transform_patterns") else 0
    meta.mark_complete("source")
    meta.mark_complete("analyze")
    meta.log("analyzed", datasets=len(datasets), recommendations=len(valid), rejected=len(rejected), provider=generated_by)
    return {"recommendations": len(valid), "rejected": rejected, "insights": len(insights), "provider": generated_by,
            "template_steps_bound": bound, "ingestion_alternatives": alternatives}


def refresh_quality_after(rt: PipelineRuntime) -> None:
    """Projected quality after the current transformation steps (shown on cards, dashboards and reviews)."""
    from ..profiling.profiler import light_quality

    rt._transformed.clear()
    for ds in rt.meta.selected_datasets():
        try:
            rt.meta.analysis.quality_after[ds.id] = light_quality(rt.transformed(ds.id))
        except Exception:  # noqa: BLE001 - informational only
            rt.meta.analysis.quality_after.pop(ds.id, None)


# ------------------------------------------------------------------ recommendations
def _sample_columns(rt: PipelineRuntime, dataset_id: str) -> list[str]:
    df, _ = apply_steps(rt.raw(dataset_id).head(300), rt.steps_for(dataset_id), rt.context())
    return [c for c in df.columns if c != "__row_id"]


def apply_recommendations(rt: PipelineRuntime, ids: list[str] | None) -> dict[str, Any]:
    meta = rt.meta
    targets = [r for r in meta.recommendations if r.status == "pending" and (ids is None or r.id in ids)]
    # schema-renaming steps go last so earlier steps still see original column names
    targets.sort(key=lambda r: (r.action.get("transform") or {}).get("type") == "standardize_column_names")
    applied, failed = [], []
    for rec in targets:
        if rec.action.get("kind") != "add_transform":
            continue
        t = rec.action["transform"]
        cols = _sample_columns(rt, rec.dataset_id)
        problems = policy.validate_transform(t["type"], t.get("params") or {}, cols)
        if problems:
            failed.append({"id": rec.id, "title": rec.title, "problems": problems})
            continue
        meta.transformations.append(TransformStep(type=t["type"], dataset_id=rec.dataset_id, params=t.get("params") or {}, origin="ai",
                                                  recommendation_id=rec.id, label=rec.title))
        rec.status = "applied"
        applied.append(rec.id)
    meta.log("recommendations_applied", count=len(applied))
    refresh_quality_after(rt)
    return {"applied": applied, "failed": failed}


def set_recommendation_status(meta: PipelineMetadata, rec_id: str, status: str) -> Recommendation:
    rec = next((r for r in meta.recommendations if r.id == rec_id), None)
    if not rec:
        raise FriendlyError("Recommendation not found", "It may have been refreshed by a new analysis.", status_code=404)
    if status == "pending" and rec.status == "applied":
        meta.transformations = [t for t in meta.transformations if t.recommendation_id != rec.id]
    rec.status = status  # type: ignore[assignment]
    return rec


# ------------------------------------------------------------------ transformations
def add_step(rt: PipelineRuntime, dataset_id: str, type_: str, params: dict, label: str | None = None, position: int | None = None) -> TransformStep:
    cols = _sample_columns(rt, dataset_id)
    problems = policy.validate_transform(type_, params, cols)
    if problems:
        raise FriendlyError("Check the settings", " ".join(problems))
    step = TransformStep(type=type_, dataset_id=dataset_id, params=params, label=label or describe_step(type_, params))
    if position is None:
        rt.meta.transformations.append(step)
    else:
        rt.meta.transformations.insert(position, step)
    rt.meta.log("step_added", step=step.id, type=type_)
    refresh_quality_after(rt)
    return step


def update_step(rt: PipelineRuntime, step_id: str, changes: dict) -> TransformStep:
    meta = rt.meta
    step = next((s for s in meta.transformations if s.id == step_id), None)
    if not step:
        raise FriendlyError("Step not found", "It may have been removed.", status_code=404)
    if "params" in changes:
        prior = [s for s in meta.transformations[: meta.transformations.index(step)] if s.dataset_id == step.dataset_id]
        df, _ = apply_steps(rt.raw(step.dataset_id).head(300), prior, rt.context())
        problems = policy.validate_transform(step.type, changes["params"], [c for c in df.columns if c != "__row_id"])
        if problems:
            raise FriendlyError("Check the settings", " ".join(problems))
        step.params = changes["params"]
        step.label = changes.get("label") or describe_step(step.type, step.params)
    if "enabled" in changes:
        step.enabled = bool(changes["enabled"])
    if "label" in changes and changes["label"]:
        step.label = changes["label"]
    meta.log("step_updated", step=step.id, changes=list(changes))
    refresh_quality_after(rt)
    return step


def reorder_steps(meta: PipelineMetadata, order: list[str]) -> None:
    by_id = {s.id: s for s in meta.transformations}
    new = [by_id[i] for i in order if i in by_id]
    new += [s for s in meta.transformations if s.id not in order]
    meta.transformations = new
    meta.log("steps_reordered")


# ------------------------------------------------------------------ health / fixes
def health_check(rt: PipelineRuntime) -> dict:
    refresh_quality_after(rt)
    result = run_health_check(rt)
    rt.meta.health_check = result
    return result.model_dump()


def auto_fix(rt: PipelineRuntime, fix: str) -> str:
    meta = rt.meta
    if fix == "run_analysis":
        run_analysis(rt)
        return "Analysis completed."
    if fix == "disable_failing_steps":
        n = 0
        for ds in meta.selected_datasets():
            _, res = apply_steps(rt.raw(ds.id).head(2000), rt.steps_for(ds.id), rt.context())
            for r in res:
                if r.get("status") == "error":
                    s = next(x for x in meta.transformations if x.id == r["step_id"])
                    s.enabled = False
                    n += 1
        return f"Disabled {n} failing step(s). You can fix and re-enable them in Transformation Studio."
    if fix == "add_quality_rules":
        covered = {r.dataset_id for r in meta.quality_rules if r.enabled}
        new = [r for r in heuristics.recommend_quality_rules(meta) if r.dataset_id not in covered]
        meta.quality_rules += new
        return f"Added {len(new)} recommended quality rule(s)."
    if fix == "ingestion_full_refresh":
        meta.ingestion.mode = "full"
        return "Switched to full refresh."
    if fix == "regenerate_lakehouse":
        d = heuristics.design_lakehouse(meta)
        meta.lakehouse.tables = [TableDesign(**t) for t in d["tables"]]
        meta.lakehouse.relationships = d["relationships"]
        for attr in ("catalog", "bronze_schema", "silver_schema", "gold_schema"):
            v = getattr(meta.lakehouse, attr)
            fixed = heuristics.to_snake(v or attr.split("_")[0])
            setattr(meta.lakehouse, attr, fixed)
        return "Lakehouse design regenerated."
    if fix == "prefix_table_names":
        prefix = heuristics.to_snake(meta.name)[:30]
        renames = {t.name: f"{prefix}_{t.name}" for t in meta.lakehouse.tables if not t.name.startswith(prefix + "_")}
        for t in meta.lakehouse.tables:
            t.name = renames.get(t.name, t.name)
            t.source_tables = [renames.get(x, x) for x in t.source_tables]
            if t.gold_logic.get("base"):
                t.gold_logic["base"] = renames.get(t.gold_logic["base"], t.gold_logic["base"])
            for rel in t.gold_logic.get("related", []):
                rel["table"] = renames.get(rel["table"], rel["table"])
        for r in meta.lakehouse.relationships:
            r["from_table"] = renames.get(r["from_table"], r["from_table"])
            r["to_table"] = renames.get(r["to_table"], r["to_table"])
        return f"Prefixed {len(renames)} table names with '{prefix}_' to keep them unique."
    if fix == "enable_unity_catalog":
        meta.governance.unity_catalog = True
        return "Unity Catalog enabled."
    if fix == "protect_pii":
        for p in meta.governance.pii:
            if p.action == "none":
                p.action = heuristics.PII_DEFAULT_ACTION.get(p.category, "tag")  # type: ignore[assignment]
        return "Recommended protection applied to sensitive columns."
    if fix == "add_clustering":
        for t in meta.lakehouse.tables:
            if t.layer == "silver" and not t.cluster_by and t.primary_key:
                t.cluster_by = t.primary_key[:1]
        return "Liquid clustering added."
    if fix == "select_dependencies":
        for s in meta.transformations:
            for ref in [s.params.get("right_dataset")] + list(s.params.get("datasets") or []):
                d = meta.dataset(ref) if ref else None
                if d:
                    d.selected = True
        return "Required datasets selected."
    if fix == "move_secrets":
        for k in [k for k in meta.source.config if any(w in k.lower() for w in ("password", "secret", "token", "api_key", "private_key", "access_key"))]:
            meta.source.config.pop(k, None)
        return "Plain-text credentials removed. Re-enter them in the connection form so they're stored encrypted."
    raise FriendlyError("Unknown fix", "This problem can't be fixed automatically.")


def settings_summary() -> dict:
    s = get_settings()
    return {"ai_provider": "anthropic" if llm.is_enabled() else "heuristic", "databricks_connected": bool(s.databricks_host and s.databricks_token),
            "databricks_host": s.databricks_host, "environment": s.environment}
